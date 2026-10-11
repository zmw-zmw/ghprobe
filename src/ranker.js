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

// 兜底链：主域名候选全灭且配置了替身时，返回替身域名清单
export function neededFallbacks(ranked, cfg) {
  const list = [];
  for (const [domain, alternatives] of Object.entries(cfg.fallbacks || {})) {
    const rs = ranked.get(domain) || [];
    if (!rs.length && alternatives.length) { list.push(...alternatives); }
  }
  return [...new Set(list)];
}
