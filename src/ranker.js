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

// 多次采样合并（纯函数）：把首轮结果与复测样本按 (domain, ip) 分组，
//   · 有活样本 -> score = 活样本均值 + 每个失败样本罚 penaltyMs（抖动 IP 别排第一）
//   · 全部失败 -> 保留失败结果（字段取首个，ok=false，供 blockedDomainsFromRaw 判读）
// 为什么需要：单次采样抖动大时排名近乎随机 —— 而每次换 IP 都要刷 DNS 缓存、断连接池，
// 排名稳比单次「最优」更重要。0.3.0 前工具排名单采样，实测同一 IP 相邻两轮分差可达数倍。
export function mergeSamples(first, extra, penaltyMs = 500) {
  const by = new Map();
  const push = (r) => {
    if (!r || !r.domain || !r.ip) { return; }
    const k = `${r.domain}|${r.ip}`;
    if (!by.has(k)) { by.set(k, []); }
    by.get(k).push(r);
  };
  for (const r of first) { push(r); }
  for (const r of extra) { push(r); }
  const out = [];
  for (const rs of by.values()) {
    const ok = rs.filter((r) => r.ok);
    if (!ok.length) { out.push({ ...rs[0], ok: false }); continue; }
    const failed = rs.length - ok.length;
    const avg = Math.round(ok.reduce((a, r) => a + r.score, 0) / ok.length);
    out.push({ ...ok[0], ok: true, score: avg + failed * penaltyMs, samples: rs.length });
  }
  return out;
}
