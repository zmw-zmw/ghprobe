// SPDX-License-Identifier: GPL-3.0
// Copyright (C) 2026 zmw
// 一轮完整探测：DoH 候选 + 内置池 -> 三关并发探测 -> 排名 -> 兜底轮
import { resolveAll } from "./doh.js";
import { probeIp, pool } from "./prober.js";
import { rank, neededFallbacks } from "./ranker.js";

export async function runProbe(cfg, log) {
  const say = log || (() => {});
  const all = [];
  const poolIps = Object.values(cfg.ipPools || {}).flat();
  for (const domain of cfg.domains) {
    say(`解析 ${domain}`);
    const { ips } = await resolveAll(cfg.doh, domain, cfg.timeouts.dohMs);
    const candidates = [...new Set([...ips, ...poolIps])].slice(0, cfg.probe.maxCandidates);
    say(`  候选 ${candidates.length} 个: ${candidates.join(", ")}`);
    const rs = await pool(candidates.map((ip) => () => probeIp(domain, ip, cfg)), cfg.probe.concurrency);
    all.push(...rs);
  }
  let ranked = rank(all, cfg);
  // 兜底轮：主域名全灭且配了替身 -> 探测替身域名
  const extra = new Map();
  for (const alt of neededFallbacks(ranked, cfg)) {
    say(`兜底探测 ${alt}`);
    const { ips } = await resolveAll(cfg.doh, alt, cfg.timeouts.dohMs);
    const candidates = [...new Set(ips)].slice(0, cfg.probe.maxCandidates);
    const rs = await pool(candidates.map((ip) => () => probeIp(alt, ip, cfg)), cfg.probe.concurrency);
    for (const [d, list] of rank(rs, cfg)) {
      if (list.length) { extra.set(d, list); }
    }
  }
  return { ranked, extra, raw: all, at: new Date().toISOString() };
}
