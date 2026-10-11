// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 zmw
// 调度层：健康检查（哨兵）+ 决策 + 部分更新 + 全灭护栏
// 无状态文件：缺失域名冷却表直接编码进 hosts 块注释，跨进程、跨重启不丢
import fs from "node:fs";
import { probeIp, pool } from "./prober.js";
import { runProbe } from "./probe.js";
import { applyHosts, mergeHosts, WIN_HOSTS, acquireHostsLock, releaseHostsLock } from "./hosts.js";

const BEGIN = "# === ghprobe begin ===";
const END = "# === ghprobe end ===";

// 从 hosts 内容解析 ghprobe 块：有效 IP 映射、同名备选 IP、缺失域名冷却表
// 块内行格式：`IP 域名`（同域名可多行：第一条 = 主 IP，其余 = 备选）或 `# absent 域名 时间戳`
// 主 IP 进 entries（决策/探活只看它），备选进 extras（原样写回，供客户端 fallback）
export function parseBlock(content) {
  const entries = new Map();
  const extras = new Map();
  const absent = new Map();
  let inBlock = false;
  for (const raw of String(content || "").split(/\r?\n/)) {
    const line = raw.trim();
    if (line.startsWith(BEGIN)) { inBlock = true; continue; }
    if (line.startsWith(END)) { inBlock = false; continue; }
    if (!inBlock) { continue; }
    if (line.startsWith("#")) {
      const m = line.match(/^#\s+absent\s+(\S+)\s+(\S+)/);
      if (m) { absent.set(m[1].toLowerCase(), m[2]); }
      continue;
    }
    const parts = line.split(/\s+/);
    if (parts.length >= 2 && parts[0] && parts[1]) {
      const domain = parts[1].toLowerCase();
      const ip = parts[0];
      if (!entries.has(domain)) { entries.set(domain, ip); continue; }
      if (entries.get(domain) === ip) { continue; }
      const list = extras.get(domain) || [];
      if (!list.includes(ip)) { list.push(ip); extras.set(domain, list); }
    }
  }
  return { entries, extras, absent };
}

// 生成健康检查用的 hosts 块：有效条目（每域名 主 IP + 备选）+ 缺失域名冷却注释
// extras：domain -> [备选 IP...]。同域名多行让客户端在首个 IP 抖动时可自动 fallback。
export function buildHealthBlock(entries, absent, extras = new Map()) {
  const lines = [BEGIN, `# generated ${new Date().toISOString()} by ghprobe`];
  for (const [domain, ip] of entries) {
    lines.push(`${ip} ${domain}`);
    for (const alt of extras.get(domain) || []) {
      if (alt && alt !== ip) { lines.push(`${alt} ${domain}`); }
    }
  }
  for (const [domain, ts] of absent) { lines.push(`# absent ${domain} ${ts}`); }
  lines.push(END);
  return lines.join("\n");
}

// 合法域名全集 = 主域名 + 兜底域名；缺失检测与 orphan 清理都以它为准
export function targetDomains(cfg) {
  const fb = Object.values(cfg.fallbacks || {}).flat();
  return [...new Set([...(cfg.domains || []), ...fb])];
}

// 由一轮探测结果生成待写入的块。
// 与 health 写出的块保持同构：没有活 IP 的目标域名记入 `# absent` 冷却注释，
// 否则下次 health 会把这些域名当「缺失」而白跑一次全量。
export function blockFromProbeResult(cfg, r) {
  const maxPer = Math.max(1, cfg.hosts?.maxEntriesPerDomain ?? 2);
  const entries = new Map();
  const extras = new Map();
  const put = (d, list) => {
    if (!list || !list.length) { return; }
    entries.set(d, list[0].ip);
    const alt = list.slice(1, maxPer).map((x) => x.ip);
    if (alt.length) { extras.set(d, alt); }
  };
  for (const [d, rs] of r.ranked || []) { put(d, rs); }
  for (const [d, rs] of r.extra || []) { put(d, rs); }
  const absent = new Map();
  const now = new Date().toISOString();
  for (const d of targetDomains(cfg)) { if (!entries.has(d)) { absent.set(d, now); } }
  return buildHealthBlock(entries, absent, extras);
}

// 全灭护栏（写入前判定）：新块一条有效 IP 都没有、而 hosts 里还有旧条目时，必须拒绝写入 ——
// 否则会把原本可用的条目一起抹掉（`probe --apply` 此前缺这道护栏，只有 health 有）。
export function shouldKeepOldBlock(oldContent, newBlock) {
  return parseBlock(newBlock).entries.size === 0 && parseBlock(oldContent).entries.size > 0;
}

// 决策（纯函数）：输入「已写入条目的探活结果」+ 当前块状态，输出动作
// 横向判据：严格多数条目同时失败视为网络故障（本轮不动，避开黑洞窗口）；
// 单条目失败或缺失域名（非冷却）才触发全量重排
//
// 🔴 2026-10-11 两个关键修正：
//   ① 探活结果现在**同时包含主条目与备选条目**（每条带 role: "main" / "alt"）。
//      一个域名只有「它所有已写入条目全部失败」才算挂 —— 备选还活着时不该重排。
//   ② 主挂了、备选活着 → **把备选提上来（promote）**，不重排。
//      这条是针对实测故障的：主 IP 变成假活（返回 400）而备选是好的，旧逻辑不知道备选存在，
//      直接去重排 → 撞上 IP 抖动窗口 → 换了个更差的，用户反而断网。
//      备选本来就是为了这一刻存在的，不该只写不读。
export function decide(probeResults, current, cfg) {
  // 按域名聚合：只有全部条目都失败才算这个域名挂了
  const byDomain = new Map();
  for (const r of probeResults) {
    if (!byDomain.has(r.domain)) { byDomain.set(r.domain, []); }
    byDomain.get(r.domain).push(r);
  }
  const failed = new Set();
  const promote = new Map();
  for (const [d, rs] of byDomain) {
    const alive = rs.filter((r) => r.ok);
    if (alive.length === 0) { failed.add(d); continue; }
    // 主条目失败但有备选活着 -> 提升备选（不重排）
    const main = rs.find((r) => r.role !== "alt");
    if (main && !main.ok) { promote.set(d, alive[0].ip); }
  }
  const total = current.entries.size;

  // 只有「已写入条目全部失败」才可能是网络级故障（黑洞窗口），此时本轮不动、避开窗口。
  // 只要还有任意一条健康，就说明链路是通的，失败的那些是 IP 陈旧/真死，应当重排换 IP。
  // 🔴 旧判据 `failed.size * 2 > total`（多数失败即放弃）已证实会误触发：分母只数已写入
  //    条目、常低到 3~4，实测「3 条陈旧 + 1 条健康」被误判成断网 → 该修的时候不修。
  if (total >= 2 && failed.size === total) {
    return { action: "none", reason: "全部已写入 IP 同时失败，疑似网络故障", promote: new Map() };
  }

  const cooldownMs = (cfg.schedule?.absentCooldownHours ?? 1) * 3600_000;
  const now = Date.now();
  const targets = targetDomains(cfg);
  const missing = new Set();
  for (const d of targets) {
    if (current.entries.has(d)) { continue; }
    const ts = current.absent.get(d);
    if (ts && now - new Date(ts).getTime() < cooldownMs) { continue; }
    missing.add(d);
  }
  // orphan：hosts 块里已不在配置（含兜底）中的域名，需清理
  const orphan = [...current.entries.keys()].filter((d) => !targets.includes(d));

  const diagnose = [...new Set([...failed, ...missing, ...orphan])];
  if (diagnose.length === 0 && promote.size === 0) {
    return { action: "none", reason: "全部健康", promote: new Map() };
  }
  if (diagnose.length === 0) {
    return { action: "full", domains: [], promote, reason: `主 IP 失效，提上备选: ${[...promote.keys()].join(", ")}` };
  }
  return { action: "full", domains: diagnose, promote, reason: `需重排: ${diagnose.join(", ")}` };
}

// 部分更新（纯函数）：只改 diagnose 域名；全灭护栏保证不把好 IP 写成空
// 返回的新 entries/absent 用于与当前对比，changed 记录真正换掉 IP 的域名
// stuck：被诊断了、但本轮一个活 IP 都没找到、只能保留旧值的域名（黑洞窗口里必然出现，
//        显式报出来，否则日志只写「无变化」会让人以为工具没干活）
export function applyDelta(current, ranked, extra, diagnose, cfg, promote = new Map()) {
  const entries = new Map(current.entries);
  const extras = new Map(current.extras || []);
  const absent = new Map(current.absent);
  const changed = [];
  const now = new Date().toISOString();
  const allResult = new Map([...ranked, ...extra]);
  const maxPer = Math.max(1, cfg.hosts?.maxEntriesPerDomain ?? 2);

  // 0) 提升：主 IP 失效、备选还活着 -> 备选上位，旧主降为备选。
  //    旧主留着当兜底 —— GitHub 的 IP 是分钟级抖动，它可能下一分钟就活了。
  for (const [d, ip] of promote) {
    const oldMain = entries.get(d);
    const alts = (extras.get(d) || []).filter((x) => x !== ip);
    if (oldMain && oldMain !== ip && !alts.includes(oldMain)) { alts.unshift(oldMain); }
    entries.set(d, ip);
    const kept = alts.slice(0, maxPer - 1);
    if (kept.length) { extras.set(d, kept); } else { extras.delete(d); }
    absent.delete(d);
    changed.push(d);
  }

  for (const d of diagnose) {
    const list = allResult.get(d) || [];
    const best = list[0];
    if (best) {
      if (entries.get(d) !== best.ip) { entries.set(d, best.ip); changed.push(d); }
      // 🔴 备选是「合并」而不是「覆盖」：本轮只探到 1 个活 IP 时，把原有备选保留下来。
      //    旧写法 `alt.length ? set : delete` 会在抖动窗口里（活 IP 少）顺手删掉备选 ——
      //    恰恰在最需要 fallback 的时候把兜底丢了。新的排前、旧的排后，超出 maxPer 截断。
      const freshAlt = list.slice(1, maxPer).map((x) => x.ip);
      const oldAlt = (extras.get(d) || []).filter((x) => x !== best.ip);
      const merged = [...new Set([...freshAlt, ...oldAlt])].slice(0, maxPer - 1);
      if (merged.length) { extras.set(d, merged); } else { extras.delete(d); }
      absent.delete(d);
    } else if (!entries.has(d)) {
      absent.set(d, now);
    }
  }

  // orphan 清理：hosts 块里已不在配置（含兜底）中的域名，无条件删除（主 IP 与备选一起删）
  const allow = new Set(targetDomains(cfg));
  for (const d of [...entries.keys()]) {
    if (!allow.has(d)) { entries.delete(d); changed.push(d); }
  }
  for (const d of [...extras.keys()]) {
    if (!allow.has(d) || !entries.has(d)) { extras.delete(d); }
  }
  // orphan 已在上一步删掉，这里只剩「配置内、诊断过、却没探到活 IP、于是保留旧值」的域名
  const stuck = diagnose.filter((d) => allow.has(d) && entries.has(d) && !(allResult.get(d) || []).length);
  return { entries, extras, absent, changed, stuck };
}

function sameMap(a, b) {
  if (a.size !== b.size) { return false; }
  for (const [k, v] of a) { if (b.get(k) !== v) { return false; } }
  return true;
}

// 比较「域名 -> 备选 IP 数组」是否一致（值是有序数组，不能直接套 sameMap）
function sameExtras(a, b) {
  if (a.size !== b.size) { return false; }
  for (const [k, v] of a) {
    const w = b.get(k);
    if (!w || w.length !== v.length) { return false; }
    for (let i = 0; i < v.length; i++) { if (v[i] !== w[i]) { return false; } }
  }
  return true;
}

// 完整一轮健康检查：读 -> 测已写入 -> 决策 -> （异常时）全量探测 + 部分更新
// write=true 时才真正 applyHosts（会弹 UAC），否则仅预览
export async function runHealth(cfg, log, write = false, hostsPath = WIN_HOSTS) {
  const say = log || (() => {});
  const content = fs.readFileSync(hostsPath, "utf8");
  const current = parseBlock(content);

  if (current.entries.size === 0) {
    say("hosts 无 ghprobe 记录，触发首次全量");
    return fullUpdate(cfg, log, content, current, targetDomains(cfg), write, hostsPath);
  }

  // 🔴 主条目 + 备选条目一起探活。旧版只探主条目 —— 于是「主 IP 挂了、备选还是好的」
  //    这种最常见的情况工具根本不知道，直接去重排（撞抖动窗口），而它本来只需把备选提上来。
  const pairs = [];
  for (const [d, ip] of current.entries) {
    pairs.push([d, ip, "main"]);
    for (const alt of current.extras.get(d) || []) { pairs.push([d, alt, "alt"]); }
  }
  const jobs = pairs.map(([d, ip]) => () => probeIp(d, ip, cfg));
  const probed = await pool(jobs, cfg.probe.concurrency);
  const probeResults = probed.map((r, i) => ({ ...r, role: pairs[i][2] }));
  for (const r of probeResults) {
    say(`${r.ok ? "[OK ]" : "[FAIL]"}${r.role === "alt" ? " ALT" : "    "} ${r.domain} @ ${r.ip} err=${r.err}`);
  }

  const decision = decide(probeResults, current, cfg);
  if (decision.action === "none") {
    say(`健康：${decision.reason}`);
    return { action: "none", reason: decision.reason, block: null, stuck: [] };
  }

  say(`异常：${decision.reason}`);
  return fullUpdate(cfg, log, content, current, decision.domains, write, hostsPath, decision.promote);
}

// 全量探测 + 部分更新 + 写回；护栏与粘性都在 applyDelta 里体现。
// 只探 diagnose 里的域名：典型场景是「github.com 的 IP 死了，codeload / jsdelivr 还活着」，
// 此时探 1 个域名（~8 个候选）而不是 6 个（~48 个），失败发现到修好的时间从 ~90s 压到 ~20s。
async function fullUpdate(cfg, log, content, current, diagnose, write, hostsPath = WIN_HOSTS, promote = new Map()) {
  const say = log || (() => {});
  // diagnose 为空 = 只有「提上备选」要做，没有需要重排的域名 -> 跳过探测，直接写提升结果
  const r = diagnose.length ? await runProbe(cfg, log, diagnose) : { ranked: new Map(), extra: new Map() };
  const d = applyDelta(current, r.ranked, r.extra, diagnose, cfg, promote);

  const entriesChanged = !sameMap(d.entries, current.entries);
  const absentChanged = !sameMap(d.absent, current.absent);
  const extrasChanged = !sameExtras(d.extras, current.extras || new Map());
  const stuckNote = d.stuck.length ? `；无可用 IP 保留原值: ${d.stuck.join(", ")}` : "";
  if (!entriesChanged && !absentChanged && !extrasChanged) {
    say(`探测无变化，保持现状（护栏/粘性生效）${stuckNote}`);
    return { action: "none", reason: `无变化${stuckNote}`, block: null, stuck: d.stuck };
  }

  const block = buildHealthBlock(d.entries, d.absent, d.extras);
  // 日志里把「提上备选」和「重排换 IP」分开写，否则看日志分不清是哪种动作
  const promoted = [...promote.keys()];
  const reranked = d.changed.filter((x) => !promote.has(x));
  const parts = [];
  if (promoted.length) { parts.push(`提上备选: ${promoted.join(", ")}`); }
  if (reranked.length) { parts.push(`重排换 IP: ${reranked.join(", ")}`); }
  const msg = parts.length ? parts.join("；") : "更新缺失域名冷却记录";
  if (write) {
    const lock = acquireHostsLock();
    if (!lock) {
      say("另一进程正在写 hosts，本轮跳过（下轮健康检查会自动补写）");
      return { action: "none", reason: "写锁冲突，本轮跳过", changed: d.changed, block, stuck: d.stuck };
    }
    try {
      // 锁内重读最新 hosts：探测耗时期间他人可能已改过，避免覆盖别人刚写的新值
      const latest = fs.readFileSync(hostsPath, "utf8");
      await applyHosts(mergeHosts(latest, block));
      say(`已写入 hosts：${msg}${stuckNote}`);
    } finally { releaseHostsLock(lock); }
  } else {
    say(`预览块（加 --apply 才写入）:\n${block}`);
  }
  return { action: "full", reason: msg, changed: d.changed, block, stuck: d.stuck };
}