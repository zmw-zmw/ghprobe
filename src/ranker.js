// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 zmw
// 排名选优：按域名分组，只留三关全过的，score 升序，每域名限量
export function rank(results, cfg) {
  const byDomain = new Map();
  for (const r of results) {
    if (!byDomain.has(r.domain)) { byDomain.set(r.domain, []); }
    byDomain.get(r.domain).push(r);
  }
  const out = new Map();
  for (const [domain, rs] of byDomain) {
    const alive = rs.filter((r) => r.ok).sort((a, b) => a.score - b.score);
    out.set(domain, alive.slice(0, cfg.probe.maxPerDomain));
  }
  return out;
}

// 兜底链：主域名候选全灭且配置了替身时，返回替身域名清单。
// 🔴 必须要求该域名**本轮确实探过**（ranked 里存在这个键）。rank 对「探过但全灭」的域名
//    会写入一个空数组，对「本轮压根没探」的域名则完全不建键。部分更新只探被点名的域名，
//    若把「没探」误当「全灭」，就会白跑一轮兜底 DoH + 探测（实测每次多花 2~5s）。
export function neededFallbacks(ranked, cfg) {
  const list = [];
  for (const [domain, alternatives] of Object.entries(cfg.fallbacks || {})) {
    if (!ranked.has(domain)) { continue; }
    const rs = ranked.get(domain) || [];
    if (!rs.length && alternatives.length) { list.push(...alternatives); }
  }
  return [...new Set(list)];
}
