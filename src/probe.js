// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 zmw
// 一轮完整探测：DoH 候选 + 内置池 -> 三关并发探测 -> 排名 -> 兜底轮
import { resolveAll } from "./doh.js";
import { probeIp, pool } from "./prober.js";
import { rank, neededFallbacks } from "./ranker.js";

// 该域名该用哪些内置池。
// 默认（未配 domainPools 或配了不存在的池名）用全部池 —— 保持「与域名无关地全量进候选」
// 的老行为，由 TLS 证书终审 + 应用层终审判归属。
// 配了 domainPools 就只取指定的池：185.199.x.x（Fastly）永远不给 github.com 服务，
// 20.x 也不给 raw.githubusercontent.com 服务，互探纯属浪费——冷启动能省掉近一半候选。
export function poolsForDomain(cfg, domain) {
  const pools = cfg.ipPools || {};
  const names = cfg.domainPools?.[domain];
  if (!Array.isArray(names) || names.length === 0) { return Object.values(pools).flat(); }
  const picked = names.flatMap((n) => pools[n] || []);
  return picked.length ? picked : Object.values(pools).flat();
}

// 解析一批域名的候选 IP。域名之间并行 —— DoH 是纯网络等待，串行会把最坏耗时
// 乘上域名数（6 个域名 × dohMs 5s = 30s），并行后压回一个 dohMs。
async function resolveCandidates(cfg, domains, say, { usePool = true, prefix = "" } = {}) {
  return Promise.all(domains.map(async (domain) => {
    say(prefix ? `${prefix}探测 ${domain}` : `解析 ${domain}`);
    const { ips } = await resolveAll(cfg.doh, domain, cfg.timeouts.dohMs);
    // 🔴 两个来源**各自限额后再合并**，绝不能对合并结果做总限额。
    // 实测（2026-10）：DoH 对 github.com 返回的 8 条里有一半是 Fastly 的 185.199.x.x
    // ——那是 githubusercontent 的节点，根本不给 github.com 服务。按总限额截断时，
    // 内置池会被这堆垃圾整个挤掉，于是出现「20.29.134.23 明明是活的，工具却报
    // stuck=github.com」。分开限额后内置池一定拿得到名额。
    const fromDoh = (ips || []).slice(0, cfg.probe.maxCandidates);
    const fromPool = usePool ? poolsForDomain(cfg, domain).slice(0, cfg.probe.maxPoolIps ?? 12) : [];
    const candidates = [...new Set([...fromDoh, ...fromPool])];
    say(`  候选 ${candidates.length} 个: ${candidates.join(", ")}`);
    return { domain, candidates };
  }));
}

// 把所有 (域名, IP) 拍平成任务队列，交给一个**全局**并发池跑。
// 每个域名各自开一个池的话，实际并发 = 域名数 × concurrency（6×6=36 条 socket），
// 会把最坏耗时和瞬时连接数同时放大；全局单池才是真正的「同时最多 N 条」。
function jobsOf(cfg, resolved) {
  const jobs = [];
  for (const { domain, candidates } of resolved) {
    for (const ip of candidates) { jobs.push(() => probeIp(domain, ip, cfg)); }
  }
  return jobs;
}

// onlyDomains：只探这些域名。部分更新（health 只发现某 1 个域名坏了）时用它，
// 避免「1 个域名失效却把 6 个域名、近 50 个候选全探一遍」——那是几十秒的纯浪费。
// 传 null / 空数组 = 全量。注意兜底域名不在 cfg.domains 里，若被点名必须单独直探。
export async function runProbe(cfg, log, onlyDomains = null) {
  const say = log || (() => {});
  const fbDomains = Object.values(cfg.fallbacks || {}).flat();
  const want = onlyDomains && onlyDomains.length ? new Set(onlyDomains) : null;
  const mainDomains = cfg.domains.filter((d) => !want || want.has(d));
  const directFb = want ? [...want].filter((d) => fbDomains.includes(d) && !cfg.domains.includes(d)) : [];

  const resolved = await resolveCandidates(cfg, mainDomains, say);
  const all = await pool(jobsOf(cfg, resolved), cfg.probe.concurrency);
  const ranked = rank(all, cfg);

  // 兜底轮：主域名全灭且配了替身 -> 探测替身域名
  const extra = new Map();
  const alts = [...new Set([...neededFallbacks(ranked, cfg), ...directFb])];
  if (alts.length) {
    const altResolved = await resolveCandidates(cfg, alts, say, { usePool: false, prefix: "兜底" });
    const rs = await pool(jobsOf(cfg, altResolved), cfg.probe.concurrency);
    for (const [d, list] of rank(rs, cfg)) {
      if (list.length) { extra.set(d, list); }
    }
  }
  return { ranked, extra, raw: all, at: new Date().toISOString() };
}
