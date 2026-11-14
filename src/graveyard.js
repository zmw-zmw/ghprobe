// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 zmw
// 死 IP 坟场（0.1.13「探测全」）：记录每个域名「曾经探活成功过」的 IP 及其生死时间戳，
// 在域名 stuck（本轮候选全死）时按「最近活过」优先把坟场 IP 补进候选 —— 把 DNS 答案
// 变更后从候选面消失的历史段（57.155 / 167.82 这类多源挖出的 IP）找回来。
// 设计纪律：
//   · **只收曾经活过的 IP**（lastAlive 有值）—— 从未活过的失败候选是垃圾，不进坟场，
//     保证坟场里的每一条都有「验证过的历史」
//   · 卡住时才探测坟场（平时零额外流量），每域名上限 probe.graveyardMaxIps（默认 6，0=关）
//   · 每域名最多 24 条，超出按 lastAlive 最旧淘汰
//   · 持久化用临时文件 + rename 原子写 —— hosts NUL 事故的教训在这里同样适用
import fs from "node:fs";
import path from "node:path";
import { userDataDir } from "./hosts.js";

const CAP_PER_DOMAIN = 24;

export function graveyardPath() {
  return path.join(userDataDir(), "graveyard.json");
}

// record：探测结果回写（results 里需要有 ip / ok 字段）。
//   ok=true  -> lastAlive=now（并清掉 lastFail）
//   ok=false -> 只更新 lastFail，且**仅当它曾经活过**；从未活过的失败不收集
export function record(gy, domain, results, now = Date.now()) {
  if (!gy) { return gy; }
  const list = gy[domain] || [];
  const byIp = new Map(list.map((e) => [e.ip, e]));
  for (const r of results) {
    if (!r || !r.ip) { continue; }
    const e = byIp.get(r.ip);
    if (r.ok) {
      const ne = e || { ip: r.ip };
      ne.lastAlive = now;
      delete ne.lastFail;
      byIp.set(r.ip, ne);
    } else if (e && e.lastAlive !== undefined) {
      e.lastFail = now;
    }
  }
  gy[domain] = [...byIp.values()]
    .sort((a, b) => (b.lastAlive || 0) - (a.lastAlive || 0))
    .slice(0, CAP_PER_DOMAIN);
  return gy;
}

// pick：某域名 stuck 时选坟场 IP —— 只挑曾经活过的（lastAlive 有值），按最近活过
// 新→旧排序，排除本轮已在候选/条目里的（exclude），最多 limit 个。
export function pick(gy, domain, exclude = new Set(), limit = 6) {
  if (!gy || limit <= 0) { return []; }
  return (gy[domain] || [])
    .filter((e) => e.lastAlive && !exclude.has(e.ip))
    .sort((a, b) => (b.lastAlive || 0) - (a.lastAlive || 0))
    .slice(0, limit)
    .map((e) => e.ip);
}

// load：读坟场文件；不存在/损坏返回空对象（坟场是加速器不是依赖，坏了就重建）
export function load() {
  try { return JSON.parse(fs.readFileSync(graveyardPath(), "utf8")); } catch { return {}; }
}

// save：临时文件 + rename 原子写；失败静默（坟场丢了就重建，不阻塞主流程）
export function save(gy) {
  if (!gy) { return false; }
  try {
    const p = graveyardPath();
    fs.mkdirSync(path.dirname(p), { recursive: true });
    const tmp = `${p}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(gy));
    fs.renameSync(tmp, p);
    return true;
  } catch { return false; }
}
