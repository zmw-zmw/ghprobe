// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 zmw
// 调度层：健康检查（哨兵）+ 决策 + 部分更新 + 全灭护栏
// 无状态文件：缺失域名冷却表直接编码进 hosts 块注释，跨进程、跨重启不丢
import fs from "node:fs";
import { probeIp, pool } from "./prober.js";
import { runProbe } from "./probe.js";
import { applyHosts, mergeHosts, WIN_HOSTS, acquireHostsLock, releaseHostsLock } from "./hosts.js";

const BEGIN = "# === ghprobe begin ===";
const END = "# === ghprobe end ===";

// 从 hosts 内容解析 ghprobe 块：有效 IP 映射、缺失域名冷却表
// 块内行格式：`IP 域名` 或 `# absent 域名 时间戳`
export function parseBlock(content) {
  const entries = new Map();
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
      entries.set(parts[1].toLowerCase(), parts[0]);
    }
  }
  return { entries, absent };
}

// 生成健康检查用的 hosts 块：有效条目 + 缺失域名冷却注释
export function buildHealthBlock(entries, absent) {
  const lines = [BEGIN, `# generated ${new Date().toISOString()} by ghprobe`];
  for (const [domain, ip] of entries) { lines.push(`${ip} ${domain}`); }
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
  const entries = new Map();
  for (const [d, rs] of r.ranked || []) { if (rs.length) { entries.set(d, rs[0].ip); } }
  for (const [d, rs] of r.extra || []) { if (rs.length) { entries.set(d, rs[0].ip); } }
  const absent = new Map();
  const now = new Date().toISOString();
  for (const d of targetDomains(cfg)) { if (!entries.has(d)) { absent.set(d, now); } }
  return buildHealthBlock(entries, absent);
}

// 全灭护栏（写入前判定）：新块一条有效 IP 都没有、而 hosts 里还有旧条目时，必须拒绝写入 ——
// 否则会把原本可用的条目一起抹掉（`probe --apply` 此前缺这道护栏，只有 health 有）。
export function shouldKeepOldBlock(oldContent, newBlock) {
  return parseBlock(newBlock).entries.size === 0 && parseBlock(oldContent).entries.size > 0;
}

// 决策（纯函数）：输入已写入 IP 的探活结果 + 当前块状态，输出动作
// 横向判据：严格多数条目同时失败视为网络故障（本轮不动，避开黑洞窗口）；
// 单条目失败或缺失域名（非冷却）才触发全量重排
export function decide(probeResults, current, cfg) {
  const failed = new Set(probeResults.filter((r) => !r.ok).map((r) => r.domain));
  const total = current.entries.size;

  // 只有「已写入条目全部失败」才可能是网络级故障（黑洞窗口），此时本轮不动、避开窗口。
  // 只要还有任意一条健康，就说明链路是通的，失败的那些是 IP 陈旧/真死，应当重排换 IP。
  // 🔴 旧判据 `failed.size * 2 > total`（多数失败即放弃）已证实会误触发：分母只数已写入
  //    条目、常低到 3~4，实测「3 条陈旧 + 1 条健康」被误判成断网 → 该修的时候不修。
  if (total >= 2 && failed.size === total) {
    return { action: "none", reason: "全部已写入 IP 同时失败，疑似网络故障" };
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
  if (diagnose.length === 0) { return { action: "none", reason: "全部健康" }; }
  return { action: "full", domains: diagnose, reason: `需重排: ${diagnose.join(", ")}` };
}

// 部分更新（纯函数）：只改 diagnose 域名；全灭护栏保证不把好 IP 写成空
// 返回的新 entries/absent 用于与当前对比，changed 记录真正换掉 IP 的域名
export function applyDelta(current, ranked, extra, diagnose, cfg) {
  const entries = new Map(current.entries);
  const absent = new Map(current.absent);
  const changed = [];
  const now = new Date().toISOString();
  const allResult = new Map([...ranked, ...extra]);

  for (const d of diagnose) {
    const best = (allResult.get(d) || [])[0];
    if (best) {
      if (entries.get(d) !== best.ip) { entries.set(d, best.ip); changed.push(d); }
      absent.delete(d);
    } else if (!entries.has(d)) {
      absent.set(d, now);
    }
  }

  // orphan 清理：hosts 块里已不在配置（含兜底）中的域名，无条件删除
  const allow = new Set(targetDomains(cfg));
  for (const d of [...entries.keys()]) {
    if (!allow.has(d)) { entries.delete(d); changed.push(d); }
  }
  return { entries, absent, changed };
}

function sameMap(a, b) {
  if (a.size !== b.size) { return false; }
  for (const [k, v] of a) { if (b.get(k) !== v) { return false; } }
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

  const jobs = [...current.entries].map(([d, ip]) => () => probeIp(d, ip, cfg));
  const probeResults = await pool(jobs, cfg.probe.concurrency);
  for (const r of probeResults) {
    say(`${r.ok ? "[OK ]" : "[FAIL]"} ${r.domain} @ ${r.ip} err=${r.err}`);
  }

  const decision = decide(probeResults, current, cfg);
  if (decision.action === "none") {
    say(`健康：${decision.reason}`);
    return { action: "none", reason: decision.reason, block: null };
  }

  say(`异常：${decision.reason}`);
  return fullUpdate(cfg, log, content, current, decision.domains, write, hostsPath);
}

// 全量探测 + 部分更新 + 写回；护栏与粘性都在 applyDelta 里体现
async function fullUpdate(cfg, log, content, current, diagnose, write, hostsPath = WIN_HOSTS) {
  const say = log || (() => {});
  const r = await runProbe(cfg, log);
  const d = applyDelta(current, r.ranked, r.extra, diagnose, cfg);

  const entriesChanged = !sameMap(d.entries, current.entries);
  const absentChanged = !sameMap(d.absent, current.absent);
  if (!entriesChanged && !absentChanged) {
    say("探测无变化，保持现状（护栏/粘性生效）");
    return { action: "none", reason: "无变化", block: null };
  }

  const block = buildHealthBlock(d.entries, d.absent);
  const msg = d.changed.length ? `更新域名: ${d.changed.join(", ")}` : "更新缺失域名冷却记录";
  if (write) {
    const lock = acquireHostsLock();
    if (!lock) {
      say("另一进程正在写 hosts，本轮跳过（下轮健康检查会自动补写）");
      return { action: "none", reason: "写锁冲突，本轮跳过", changed: d.changed, block };
    }
    try {
      // 锁内重读最新 hosts：探测耗时期间他人可能已改过，避免覆盖别人刚写的新值
      const latest = fs.readFileSync(hostsPath, "utf8");
      await applyHosts(mergeHosts(latest, block));
      say(`已写入 hosts：${msg}`);
    } finally { releaseHostsLock(lock); }
  } else {
    say(`预览块（加 --apply 才写入）:\n${block}`);
  }
  return { action: "full", reason: msg, changed: d.changed, block };
}