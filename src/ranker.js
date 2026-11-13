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

// 备选差异化（0.1.7，纯函数）：从有序候选里给主 IP 挑 `count` 个备选，
// **优先挑不同网段的** —— hosts 的备选只在「主 IP 死了」时被客户端挨个尝试，
// 同 /24（常为同一 POP / 同一汇聚点）的备选往往和主 IP 一起死，等于没兜底。
// 优先级：不同 /16 > 同 /16 不同 /24 > 同 /24（保底按原顺序补齐）。
// list 元素是 { ip, ... } 或裸 IP 字符串，两者都认；返回 IP 字符串数组。
export function pickAlts(list, primaryIp, count) {
  const n = Math.max(0, count | 0);
  if (!n) { return []; }
  const net = (ip, k) => String(ip).split(".").slice(0, k).join(".");
  const used16 = new Set([net(primaryIp, 2)]);
  const used24 = new Set([net(primaryIp, 3)]);
  const rest = (list || []).map((x) => (typeof x === "string" ? x : x.ip)).filter((ip) => ip && ip !== primaryIp);
  const picked = [];
  for (const tier of [0, 1, 2]) {
    for (const ip of rest) {
      if (picked.includes(ip)) { continue; }
      const t = used16.has(net(ip, 2)) ? (used24.has(net(ip, 3)) ? 2 : 1) : 0;
      if (t !== tier) { continue; }
      picked.push(ip);
      used16.add(net(ip, 2));
      used24.add(net(ip, 3));
      if (picked.length >= n) { return picked; }
    }
  }
  return picked;
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
