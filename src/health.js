// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 zmw
// 调度层：健康检查（哨兵）+ 决策 + 部分更新 + 全灭护栏
// 无状态文件：缺失域名冷却表直接编码进 hosts 块注释，跨进程、跨重启不丢
import fs from "node:fs";
import { probeIp, pool } from "./prober.js";
import { runProbe } from "./probe.js";
import { pickAlts } from "./ranker.js";
import { applyHosts, mergeHosts, WIN_HOSTS, acquireHostsLock, releaseHostsLock } from "./hosts.js";
import { detectProxy, probeThroughProxy } from "./proxy.js";

const BEGIN = "# === ghprobe begin ===";
const END = "# === ghprobe end ===";

// 从 hosts 内容解析 ghprobe 块：有效 IP 映射、同名备选 IP、缺失域名冷却表、指纹阻断表、
// 抖动保留表（suspect，0.1.7）、代理保活表（idle，0.1.8）
// 块内行格式：
//   `IP 域名`（同域名可多行：第一条 = 主 IP，其余 = 备选）
//   `# absent 域名 时间戳`   —— 探测过、确实没有可用 IP
//   `# blocked 域名 时间戳`  —— 探测不可判：TCP 连上了但 TLS 被本机指纹阻断（详见 prober.js）
//   `# suspect 域名 时间戳`  —— 直连探活失败但代理视角可达：疑似本机链路抖动，已宽限一轮；
//                              宽限期内（algorithm.suspectGraceMs）再失败就立即动手
//   `# proxy-idle 时间戳`    —— 保活模式标记：条目被注释（代理存活时自动启用）
//   `# idle IP 域名`         —— 保活条目：对系统是无害注释，ghprobe 用来在代理停止时
//                              **立即转正**（<1s 恢复直连解析，不等重测）—— 无缝切换的关键
// 主 IP 进 entries（决策/探活只看它），备选进 extras（原样写回，供客户端 fallback）
export function parseBlock(content) {
  const entries = new Map();
  const extras = new Map();
  const absent = new Map();
  const blocked = new Map();
  const suspect = new Map();
  const idle = new Map();
  let idleSince = null;
  let inBlock = false;
  for (const raw of String(content || "").split(/\r?\n/)) {
    const line = raw.trim();
    if (line.startsWith(BEGIN)) { inBlock = true; continue; }
    if (line.startsWith(END)) { inBlock = false; continue; }
    if (!inBlock) { continue; }
    if (line.startsWith("#")) {
      const ma = line.match(/^#\s+absent\s+(\S+)\s+(\S+)/);
      if (ma) { absent.set(ma[1].toLowerCase(), ma[2]); continue; }
      const mb = line.match(/^#\s+blocked\s+(\S+)\s+(\S+)/);
      if (mb) { blocked.set(mb[1].toLowerCase(), mb[2]); continue; }
      const ms = line.match(/^#\s+suspect\s+(\S+)\s+(\S+)/);
      if (ms) { suspect.set(ms[1].toLowerCase(), ms[2]); continue; }
      const mp = line.match(/^#\s+proxy-idle\s+(\S+)/);
      if (mp) { idleSince = mp[1]; continue; }
      const mi = line.match(/^#\s+idle\s+(\S+)\s+(\S+)/);
      if (mi) {
        const domain = mi[2].toLowerCase();
        const list = idle.get(domain) || [];
        if (!list.includes(mi[1])) { list.push(mi[1]); idle.set(domain, list); }
      }
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
  return { entries, extras, absent, blocked, suspect, idle, idleSince };
}

// 生成健康检查用的 hosts 块：有效条目（每域名 主 IP + 备选）+ 冷却/阻断/抖动注释。
// idle=true（0.1.8 代理保活模式）：IP 行全部写成 `# idle` 注释 —— 对系统零生效
// （不影响代理的 DNS 流程，尤其 Clash fake-ip/TUN 模式下 hosts 钉 IP 反而会绕过代理），
// 但 ghprobe 读得回来，代理一停立即转正。extras：domain -> [备选 IP...]。
export function buildHealthBlock(entries, absent, extras = new Map(), blocked = new Map(), suspect = new Map(), idle = false) {
  const lines = [BEGIN, `# generated ${new Date().toISOString()} by ghprobe`];
  if (idle) { lines.push(`# proxy-idle ${new Date().toISOString()} (entries commented: proxy alive, auto-restore on proxy stop)`); }
  const putIp = (ip, domain) => lines.push(idle ? `# idle ${ip} ${domain}` : `${ip} ${domain}`);
  for (const [domain, ip] of entries) {
    putIp(ip, domain);
    for (const alt of extras.get(domain) || []) {
      if (alt && alt !== ip) { putIp(alt, domain); }
    }
  }
  for (const [domain, ts] of absent) { lines.push(`# absent ${domain} ${ts}`); }
  for (const [domain, ts] of blocked) { lines.push(`# blocked ${domain} ${ts}`); }
  for (const [domain, ts] of suspect) { lines.push(`# suspect ${domain} ${ts}`); }
  lines.push(END);
  return lines.join("\n");
}

// 保活表 -> 活动条目（恢复用）：每域名第一行是主 IP，其余是备选
export function idleToActive(idle) {
  const entries = new Map();
  const extras = new Map();
  for (const [domain, ips] of idle || []) {
    if (!ips || !ips.length) { continue; }
    entries.set(domain, ips[0]);
    if (ips.length > 1) { extras.set(domain, ips.slice(1)); }
  }
  return { entries, extras };
}

// 活动块文本 -> 保活块文本（parse + 重建，一行转换）
export function activeBlockToIdle(block) {
  const p = parseBlock(block);
  return buildHealthBlock(p.entries, p.absent, p.extras, p.blocked, p.suspect, true);
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
    // 0.1.7 备选差异化：备选优先选不同网段的 IP（同段常属同一 POP，一起死 = 备选白写）
    const alt = pickAlts(list, list[0].ip, maxPer - 1);
    if (alt.length) { extras.set(d, alt); }
  };
  for (const [d, rs] of r.ranked || []) { put(d, rs); }
  for (const [d, rs] of r.extra || []) { put(d, rs); }
  const absent = new Map();
  const blocked = new Map();
  const tlsBlocked = blockedDomainsFromRaw(r.raw);
  const now = new Date().toISOString();
  for (const d of targetDomains(cfg)) {
    if (entries.has(d)) { continue; }
    // 与 health 路径保持同构：指纹阻断写 `# blocked`，确实无可用 IP 写 `# absent`
    if (tlsBlocked.has(d)) { blocked.set(d, now); } else { absent.set(d, now); }
  }
  return buildHealthBlock(entries, absent, extras, blocked);
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
//
// vantage（0.1.7，可选）= { aliveIps: Set("domain|ip") } —— 本地代理对失败条目的第二视角
// 判活结果（runHealth 算，纯函数不关心怎么来的）。规则：
//   · 某域名全部条目直连失败，但代理视角说其中某条 IP 是活的 → 大概率是**本机链路抖动**
//     （代理出口在境外，它说活 = IP 全局没死）。本轮不重排不切换 —— 抖动窗口里换谁都一样烂，
//     纯打扰。域名记入 suspects，块里写 `# suspect` 注释（跨进程/重启不丢）。
//   · 宽限期内（algorithm.suspectGraceMs，默认 10 分钟）**再**失败 → 不是抖动是路由级问题，
//     立即进入 diagnose 动手切 —— 宽限只买一轮，不会无限拖延。
//   · 代理视角也说死 → 确认真死，照旧立即切（不受宽限影响）。
export function decide(probeResults, current, cfg, vantage = null) {
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
  // 0.1.7：有代理视角数据时跳过这道护栏 —— 代理说某条 IP 活着 = 不是网络级故障，
  // 该宽限的宽限（suspects）、该动手的动手（确认死的照常重排），护栏反而会误伤。
  const hasVantage = Boolean(vantage && vantage.aliveIps && vantage.aliveIps.size);
  if (!hasVantage && total >= 2 && failed.size === total) {
    return { action: "none", reason: "全部已写入 IP 同时失败，疑似网络故障", promote: new Map(), suspects: new Map() };
  }

  const cooldownMs = (cfg.schedule?.absentCooldownHours ?? 1) * 3600_000;
  const now = Date.now();
  const targets = targetDomains(cfg);
  const missing = new Set();
  for (const d of targets) {
    if (current.entries.has(d)) { continue; }
    // `# absent`（确实无可用 IP）与 `# blocked`（探测不可判：本机 TLS 指纹被阻断）
    // 共用同一档冷却 —— 两者都不该每分钟重探一遍
    const ts = current.absent.get(d) || current.blocked?.get(d);
    if (ts && now - new Date(ts).getTime() < cooldownMs) { continue; }
    missing.add(d);
  }
  // orphan：hosts 块里已不在配置（含兜底）中的域名，需清理
  const orphan = [...current.entries.keys()].filter((d) => !targets.includes(d));

  // 0.1.7 代理视角判活（见函数头注释）
  const graceMs = cfg.algorithm?.suspectGraceMs ?? 600_000;
  const suspects = new Map();
  if (vantage && vantage.aliveIps && vantage.aliveIps.size) {
    for (const d of failed) {
      const rs = byDomain.get(d) || [];
      if (!rs.some((r) => vantage.aliveIps.has(`${d}|${r.ip}`))) { continue; }
      const prevTs = current.suspect?.get(d);
      if (prevTs && now - new Date(prevTs).getTime() >= 0 && now - new Date(prevTs).getTime() < graceMs) {
        continue; // 已宽限过一轮还在宽限期内 → 这次是「再失败」，立即动手（不加入 suspects）
      }
      suspects.set(d, new Date(now).toISOString());
    }
  }
  for (const d of suspects.keys()) { failed.delete(d); }

  const diagnose = [...new Set([...failed, ...missing, ...orphan])];
  if (diagnose.length === 0 && promote.size === 0) {
    if (suspects.size) {
      return { action: "suspect", reason: `直连失败但代理视角可达，疑似本机链路抖动，宽限一轮: ${[...suspects.keys()].join(", ")}`, suspects, promote: new Map() };
    }
    return { action: "none", reason: "全部健康", promote: new Map(), suspects: new Map() };
  }
  if (diagnose.length === 0) {
    return { action: "full", domains: [], promote, reason: `主 IP 失效，提上备选: ${[...promote.keys()].join(", ")}`, suspects: new Map() };
  }
  return { action: "full", domains: diagnose, promote, reason: `需重排: ${diagnose.join(", ")}`, suspects: new Map() };
}

// 部分更新（纯函数）：只改 diagnose 域名；全灭护栏保证不把好 IP 写成空
// 返回的新 entries/absent 用于与当前对比，changed 记录真正换掉 IP 的域名
// stuck：被诊断了、但本轮一个活 IP 都没找到、只能保留旧值的域名（黑洞窗口里必然出现，
//        显式报出来，否则日志只写「无变化」会让人以为工具没干活）
// 从一轮原始探测结果里挑出「指纹被阻断」的域名：
// 该域名所有候选都失败了，且**失败全部发生在 TLS 阶段（TCP 已连上）** —— 见 prober.js 的说明。
// 只有全部失败都是这一类才判定，避免把「一半 IP 黑洞 + 一半被 reset」误当成指纹阻断。
export function blockedDomainsFromRaw(raw) {
  const by = new Map();
  for (const r of raw || []) {
    if (!by.has(r.domain)) { by.set(r.domain, { total: 0, alive: 0, blocked: 0 }); }
    const e = by.get(r.domain);
    e.total++;
    if (r.ok) { e.alive++; } else if (r.tlsBlocked) { e.blocked++; }
  }
  const out = new Set();
  for (const [d, e] of by) {
    if (e.alive === 0 && e.blocked > 0 && e.blocked === e.total) { out.add(d); }
  }
  return out;
}

export function applyDelta(current, ranked, extra, diagnose, cfg, promote = new Map(), tlsBlocked = new Set()) {
  const entries = new Map(current.entries);
  const extras = new Map(current.extras || []);
  const absent = new Map(current.absent);
  const blocked = new Map(current.blocked || []);
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
      //    0.1.7：新备选先过 pickAlts 差异化 —— 优先不同网段，同段 IP 和主 IP 一起死的概率太高。
      const freshAlt = pickAlts(list, best.ip, maxPer - 1);
      const oldAlt = (extras.get(d) || []).filter((x) => x !== best.ip);
      const merged = [...new Set([...freshAlt, ...oldAlt])].slice(0, maxPer - 1);
      if (merged.length) { extras.set(d, merged); } else { extras.delete(d); }
      absent.delete(d);
      blocked.delete(d);
    } else if (!entries.has(d)) {
      // 🔴 指纹被阻断 ≠ 不可达：不写 absent，写 blocked。
      //    两者共用同一档冷却（decide 里查），但语义不同 —— blocked 表示
      //    「本机探测客户端（Node）的 TLS 指纹被识别，用户的浏览器很可能照样能访问」，
      //    写 absent 会让工具主动放弃一个其实可用的域名，日志也会误导。
      if (tlsBlocked.has(d)) { blocked.set(d, now); } else { absent.set(d, now); }
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
  // 指纹被阻断的域名（没有写进 entries，也不是 absent）
  const sniBlocked = diagnose.filter((d) => allow.has(d) && !entries.has(d) && tlsBlocked.has(d));
  return { entries, extras, absent, blocked, changed, stuck, sniBlocked };
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

// 完整一轮健康检查：读 -> 测已写入 -> （0.1.7 失败条目借本地代理做第二视角判活）-> 决策
// -> （异常时）全量探测 + 部分更新
// write=true 时才真正 applyHosts（会弹 UAC），否则仅预览。
// hooks.beforeApply（0.6.0，daemon 传）：写前门控 —— meta = { deadDomains, initial, changed,
// reason, block, cfg }，返回 false 表示「按用户行为算法推迟」，本轮不落盘、块由门控方保存。
// deps（0.1.7）= { detectProxy, probeThroughProxy } 可注入（单测不打真网络）。
export async function runHealth(cfg, log, write = false, hostsPath = WIN_HOSTS, promote = new Map(), hooks = {}, deps = {}) {
  const say = log || (() => {});
  const content = fs.readFileSync(hostsPath, "utf8");
  const current = parseBlock(content);

  // 0.1.8 代理保活模式：条目已全部注释（# idle）。分两种情况：
  //   · 代理还活着 -> 本轮什么都不做（daemon 按保活节流在测，别打扰）
  //   · 代理死了   -> daemon 没来得及恢复（监督者兜底路径），**立即转正保活条目** ——
  //     这是无缝切换的最后一道保险：哪怕 daemon 崩了，每分钟的监督任务也能在 1 分钟内恢复直连。
  if (current.entries.size === 0 && current.idle.size > 0) {
    let pi = null;
    try { pi = await (deps.detectProxy || detectProxy)(cfg); } catch { pi = null; }
    if (pi && pi.found && pi.alive) {
      say(`代理保活模式（${pi.host}:${pi.port} 存活）：hosts 条目已注释，daemon 负责保活探测`);
      return { action: "none", reason: "代理保活模式（条目已注释，代理存活）", block: null, stuck: [], proxied: true };
    }
    say("代理已停止但条目仍处于保活注释态 —— 立即恢复保活条目并重测校准");
    const { entries, extras } = idleToActive(current.idle);
    const block = buildHealthBlock(entries, current.absent, extras, current.blocked, current.suspect, false);
    if (write) {
      const lock = acquireHostsLock();
      if (!lock) {
        say("另一进程正在写 hosts，恢复本轮跳过（下一分钟监督任务会再试）");
        return { action: "none", reason: "写锁冲突，恢复推迟", block, stuck: [] };
      }
      try {
        const latest = fs.readFileSync(hostsPath, "utf8");
        await (deps.applyHosts || applyHosts)(mergeHosts(latest, block), hostsPath);
        say(`保活条目已恢复（${entries.size} 个域名）；后台继续全量重测校准`);
      } finally { releaseHostsLock(lock); }
    }
    return { action: "full", reason: "代理停止，保活条目已恢复", block, stuck: [], changed: [...entries.keys()] };
  }

  if (current.entries.size === 0) {
    say("hosts 无 ghprobe 记录，触发首次全量");
    return fullUpdate(cfg, log, content, current, targetDomains(cfg), write, hostsPath, promote, hooks, [], deps);
  }

  // 🔴 主条目 + 备选条目一起探活。旧版只探主条目 —— 于是「主 IP 挂了、备选还是好的」
  //    这种最常见的情况工具根本不知道，直接去重排（撞抖动窗口），而它本来只需把备选提上来。
  // 0.1.12 轻探活（schedule.lightProbe，默认开）：健康态**只探主条目**，备选按需才测 ——
  //    主挂了的域名当轮补测它的备选再决策。对外的 TLS 连接数直接砍半
  //    （反制裁：运营商按「境外连接频率/扇出」画像用户），决策结果与全量探活一致：
  //    主活 = 域名健康；主死 = 补测备选后照旧走 promote / 重排。
  const light = cfg.schedule?.lightProbe !== false;
  const pairs = [];
  for (const [d, ip] of current.entries) {
    pairs.push([d, ip, "main"]);
    if (!light) {
      for (const alt of current.extras.get(d) || []) { pairs.push([d, alt, "alt"]); }
    }
  }
  const jobs = pairs.map(([d, ip]) => () => (deps.probeIp || probeIp)(d, ip, cfg));
  const probed = await pool(jobs, cfg.probe.concurrency);
  let probeResults = probed.map((r, i) => ({ ...r, role: pairs[i][2] }));
  if (light) {
    const deadMains = new Set(probeResults.filter((r) => r.role === "main" && !r.ok).map((r) => r.domain));
    const altPairs = [];
    for (const d of deadMains) {
      for (const alt of current.extras.get(d) || []) { altPairs.push([d, alt, "alt"]); }
    }
    if (altPairs.length) {
      const altJobs = altPairs.map(([d, ip]) => () => (deps.probeIp || probeIp)(d, ip, cfg));
      const altProbed = await pool(altJobs, cfg.probe.concurrency);
      probeResults = probeResults.concat(altProbed.map((r, i) => ({ ...r, role: altPairs[i][2] })));
    }
  }
  for (const r of probeResults) {
    say(`${r.ok ? "[OK ]" : "[FAIL]"}${r.role === "alt" ? " ALT" : "    "} ${r.domain} @ ${r.ip} err=${r.err}`);
  }

  // 0.1.7 代理视角判活：有失败条目且本地代理活着时，问代理「这 IP 从你那边看活不活」。
  // 只对**非 TLS 指纹阻断**的失败做 —— SNI 级阻断是本机中间盒掐的，代理视角活得再好
  // 也改变不了直连被掐的事实，拿它宽限反而会把 SNI 封锁的域名拖着多耗一轮全量探测。
  let vantage = null;
  const failedPairs = probeResults.filter((r) => !r.ok && !r.tlsBlocked).map((r) => [r.domain, r.ip]);
  if (failedPairs.length) {
    let pi = null;
    try { pi = await (deps.detectProxy || detectProxy)(cfg); } catch { pi = null; }
    if (pi && pi.found && pi.alive) {
      say(`本地代理 ${pi.host}:${pi.port}（${pi.kind}）存活，对失败条目做第二视角判活`);
      const uniq = [...new Map(failedPairs.map(([d, ip]) => [`${d}|${ip}`, [d, ip]])).values()].slice(0, 8);
      const vres = await pool(uniq.map(([d, ip]) => () => (deps.probeThroughProxy || probeThroughProxy)(ip, d, cfg, pi)), 4);
      const aliveIps = new Set();
      vres.forEach((v, i) => { if (v && v.ok) { aliveIps.add(`${uniq[i][0]}|${uniq[i][1]}`); } });
      if (aliveIps.size) { vantage = { aliveIps }; }
    }
  }

  const decision = decide(probeResults, current, cfg, vantage);
  if (decision.action === "none") {
    say(`健康：${decision.reason}`);
    return { action: "none", reason: decision.reason, block: null, stuck: [] };
  }

  // 0.1.7 宽限落地：条目不动，只追加 `# suspect` 注释（跨进程记住「已宽限过」）。
  // 纯注释变更对用户零影响（不换 IP），所以不走 algorithm 门控、单独落一次盘。
  if (decision.action === "suspect") {
    const block = buildHealthBlock(current.entries, current.absent, current.extras, current.blocked, decision.suspects);
    say(`${decision.reason}（grace 期内再失败将立即切换）`);
    if (write) {
      const lock = acquireHostsLock();
      if (!lock) {
        say("另一进程正在写 hosts，suspect 标记本轮未落盘（下一轮会再记）");
        return { action: "suspect", reason: decision.reason, block, stuck: [] };
      }
      try {
        const latest = fs.readFileSync(hostsPath, "utf8");
        await (deps.applyHosts || applyHosts)(mergeHosts(latest, block), hostsPath);
        say("suspect 标记已写入 hosts 块注释");
      } finally { releaseHostsLock(lock); }
    }
    return { action: "suspect", reason: decision.reason, block, stuck: [] };
  }

  // 主备全死的域名数（0.6.0）：algorithm 门控的 P0 紧急度 —— 用户此刻真的断着
  const byDomain = new Map();
  for (const r of probeResults) {
    if (!byDomain.has(r.domain)) { byDomain.set(r.domain, []); }
    byDomain.get(r.domain).push(r);
  }
  const deadAll = [...byDomain.entries()].filter(([, rs]) => rs.every((r) => !r.ok)).map(([d]) => d);

  say(`异常：${decision.reason}`);
  return fullUpdate(cfg, log, content, current, decision.domains, write, hostsPath, decision.promote, hooks, deadAll, deps);
}

// 全量探测 + 部分更新 + 写回；护栏与粘性都在 applyDelta 里体现。
// 只探 diagnose 里的域名：典型场景是「github.com 的 IP 死了，codeload / jsdelivr 还活着」，
// 此时探 1 个域名（~8 个候选）而不是 6 个（~48 个），失败发现到修好的时间从 ~90s 压到 ~20s。
async function fullUpdate(cfg, log, content, current, diagnose, write, hostsPath = WIN_HOSTS, promote = new Map(), hooks = {}, deadAll = [], deps = {}) {
  const say = log || (() => {});
  // diagnose 为空 = 只有「提上备选」要做，没有需要重排的域名 -> 跳过探测，直接写提升结果
  const r = diagnose.length ? await (deps.runProbe || runProbe)(cfg, log, diagnose) : { ranked: new Map(), extra: new Map(), raw: [] };
  const tlsBlocked = blockedDomainsFromRaw(r.raw);
  const d = applyDelta(current, r.ranked, r.extra, diagnose, cfg, promote, tlsBlocked);

  const entriesChanged = !sameMap(d.entries, current.entries);
  const absentChanged = !sameMap(d.absent, current.absent);
  const blockedChanged = !sameMap(d.blocked, current.blocked || new Map());
  const extrasChanged = !sameExtras(d.extras, current.extras || new Map());
  const stuckNote = d.stuck.length ? `；无可用 IP 保留原值: ${d.stuck.join(", ")}` : "";
  const blockedNote = d.sniBlocked.length
    ? `；探测不可判（本机 TLS 指纹被阻断，浏览器可能仍可用）: ${d.sniBlocked.join(", ")}` : "";
  if (!entriesChanged && !absentChanged && !blockedChanged && !extrasChanged) {
    say(`探测无变化，保持现状（护栏/粘性生效）${stuckNote}${blockedNote}`);
    return { action: "none", reason: `无变化${stuckNote}${blockedNote}`, block: null, stuck: d.stuck };
  }

  const block = buildHealthBlock(d.entries, d.absent, d.extras, d.blocked);
  // 日志里把「提上备选」和「重排换 IP」分开写，否则看日志分不清是哪种动作
  const promoted = [...promote.keys()];
  const reranked = d.changed.filter((x) => !promote.has(x));
  const parts = [];
  if (promoted.length) { parts.push(`提上备选: ${promoted.join(", ")}`); }
  if (reranked.length) { parts.push(`重排换 IP: ${reranked.join(", ")}`); }
  if (d.sniBlocked.length) { parts.push(`指纹阻断: ${d.sniBlocked.join(", ")}`); }
  const msg = parts.length ? parts.join("；") : "更新缺失域名冷却记录";
  if (write) {
    // 0.6.0 用户行为门控：P0（有主备全死的域名）/ 首次写入 直接过；
    // 非紧急优化类在「用户正用浏览器」时被拒 —— 块由门控方保存，空闲后落地。
    if (hooks.beforeApply) {
      const ok = await hooks.beforeApply({
        deadDomains: deadAll, initial: current.entries.size === 0,
        changed: d.changed, reason: msg, block, cfg,
      });
      if (!ok) {
        say(`按用户行为算法推迟写入（用户正在用浏览器；修复类不受限，上限 10 分钟）`);
        return { action: "deferred", reason: "按 algorithm 推迟写入（浏览器使用中）", block, stuck: d.stuck };
      }
    }
    const lock = acquireHostsLock();
    if (!lock) {
      say("另一进程正在写 hosts，本轮跳过（下轮健康检查会自动补写）");
      return { action: "none", reason: "写锁冲突，本轮跳过", changed: d.changed, block, stuck: d.stuck };
    }
    try {
      // 锁内重读最新 hosts：探测耗时期间他人可能已改过，避免覆盖别人刚写的新值
      const latest = fs.readFileSync(hostsPath, "utf8");
      await applyHosts(mergeHosts(latest, block), hostsPath);
      say(`已写入 hosts：${msg}${stuckNote}`);
    } finally { releaseHostsLock(lock); }
  } else {
    say(`预览块（加 --apply 才写入）:\n${block}`);
  }
  return { action: "full", reason: msg, changed: d.changed, block, stuck: d.stuck };
}