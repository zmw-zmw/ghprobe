// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 zmw
// 候选池自动更新：从 GitHub 官方 api.github.com/meta 拉最新网段 → 展开成候选 IP → 缓存到用户目录。
// 为什么需要它：GitHub 的 Azure 段（20.x / 4.x）在变，内置静态池会过期
// （2026-10-11 实测：内置 24 个里有 4 个已不在官方 web 段）。
// 🔴 api.github.com/meta 未认证限 60 次/小时 —— 所以只能低频（默认每天 1 次），绝不能轮询。
import fs from "node:fs";
import path from "node:path";
import https from "node:https";
import { userDataDir } from "./hosts.js";

export function poolCachePath() {
  return path.join(userDataDir(), "pool.cache.json");
}

export function readPoolCache() {
  try {
    const o = JSON.parse(fs.readFileSync(poolCachePath(), "utf8"));
    return o && typeof o === "object" ? o : null;
  } catch { return null; }
}

function writePoolCache(obj) {
  const p = poolCachePath();
  try {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, JSON.stringify(obj, null, 2), "utf8");
  } catch { /* 写不了就算了，探测侧对缺缓存是宽容的 */ }
}

const toInt = (s) => s.split(".").reduce((a, o) => a * 256 + Number(o), 0) >>> 0;
const toIp = (v) => [(v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255].join(".");

// CIDR -> 候选 IP。
// 🔴 不能全展开：meta 的 web 段里有 /20、/22，一个 /20 就是 4096 个地址，全展开会让探测成本爆炸。
//    实际在用的是 /32 单播（GitHub 把它们逐个列出来就是给你白名单用的）与大段里的固定偏移
//    （GitHub 习惯用段内 .3 / .4 做 web/api），所以大段只采样 perBigNet 个。
export function expandCidr(cidr, perBigNet = 4) {
  const raw = String(cidr || "").trim();
  if (!raw || raw.includes(":")) { return []; } // 跳过 IPv6（本项目只探 v4）
  const slash = raw.indexOf("/");
  const net = slash === -1 ? raw : raw.slice(0, slash);
  const bits = slash === -1 ? 32 : Number(raw.slice(slash + 1));
  if (!Number.isFinite(bits) || bits < 0 || bits > 32) { return []; }
  const parts = net.split(".");
  if (parts.length !== 4 || parts.some((x) => !/^\d{1,3}$/.test(x) || Number(x) > 255)) { return []; }
  if (bits === 32) { return [net]; }
  const base = toInt(net);
  const size = 2 ** (32 - bits);
  const out = [];
  for (let i = 0; i < perBigNet; i++) {
    const v = (base + 3 + i) >>> 0;            // 从段内 .3 起
    if (v >= base + size) { break; }
    out.push(toIp(v));
  }
  return out;
}

// 用指定 IP + SNI 直连拉 meta。
// 🔴 必须用 IP 直连：api.github.com 的 DNS 在国内被污染（实测直连拿不到响应），
//    而这里恰恰是「还没有可用 IP 时」才需要它 —— 所以只能用配置里的种子池。
// onReq：把底层 request 暴露给调用方，便于「某个种子先成功」时掐掉其余在飞的请求。
function fetchMeta(ip, host, pathName, timeoutMs, onReq) {
  return new Promise((resolve, reject) => {
    const req = https.get({
      host: ip,
      port: 443,
      servername: host,
      path: pathName,
      headers: { Host: host, "User-Agent": "ghprobe", Accept: "application/json" },
      rejectUnauthorized: true,
      timeout: timeoutMs,
    }, (res) => {
      if (res.statusCode !== 200) {
        res.resume();
        reject(new Error(`HTTP ${res.statusCode}`));
        return;
      }
      let b = "";
      res.setEncoding("utf8");
      res.on("data", (d) => { b += d; });
      res.on("end", () => { try { resolve(JSON.parse(b)); } catch (e) { reject(new Error("meta 不是合法 JSON")); } });
    });
    if (onReq) { onReq(req); }
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.on("error", reject);
  });
}

// 并行试所有种子，**第一个成功的立刻返回**并掐掉其余在飞请求。
// 为什么不用 Promise.allSettled：它要等**最慢**那个（黑洞种子会一直挂到 timeoutMs），
// 实测总耗时 = 8s（正好一个 timeout），等于没并行。
// 为什么不用 Promise.any：它只给第一个成功的值，拿不到「是哪个 IP 拉到的」，日志里就没法记 via。
export function fetchFirstMeta(seeds, host, pathName, timeoutMs) {
  return new Promise((resolve, reject) => {
    if (!seeds.length) { reject(new Error("没有可用种子 IP")); return; }
    const reqs = [];
    const errs = [];
    let left = seeds.length;
    let done = false;
    const finish = (fn, arg) => {
      if (done) { return; }
      done = true;
      for (const r of reqs) { try { r.destroy(); } catch { /* 忽略 */ } }
      fn(arg);
    };
    for (const ip of seeds) {
      fetchMeta(ip, host, pathName, timeoutMs, (r) => reqs.push(r)).then(
        (json) => finish(resolve, { json, via: ip }),
        (e) => {
          errs.push(`${ip}:${e?.message || e}`);
          left -= 1;
          if (left === 0) { finish(reject, new Error(`所有种子 IP 都拉不到 ${host}（${errs.slice(0, 3).join(", ")}）`)); }
        },
      );
    }
  });
}

// 种子 IP：拉 meta 用的直连入口。优先用配置里的 seed 池，再退回 azure / fastly。
export function seedIps(cfg) {
  const p = cfg.ipPools || {};
  return [...new Set([...(p.seed || []), ...(p.azure || []), ...(p.fastly || [])])];
}

// 一轮更新：拉 meta -> 展开 -> 写缓存。失败也会写 lastAttempt（冷却），避免每分钟重试撞 60 次/小时限制。
export async function updatePool(cfg, log = () => {}) {
  const u = cfg.poolUpdate || {};
  const url = new URL(u.source || "https://api.github.com/meta");
  const host = u.host || url.hostname;
  const pathName = url.pathname || "/meta";
  const timeoutMs = u.timeoutMs ?? 8000;
  const attemptedAt = new Date().toISOString();
  const prev = readPoolCache();
  try {
    const seeds = seedIps(cfg);
    if (!seeds.length) { throw new Error("配置里没有种子 IP（ipPools.seed / azure / fastly 全为空）"); }
    // 并行试所有种子，第一个成功的立刻返回（实测 8.2s -> 亚秒级；串行时是 2m13s）。
    const { json, via } = await fetchFirstMeta(seeds, host, pathName, timeoutMs);

    const sections = u.sections || ["web", "api"];
    const maxIps = u.maxIps ?? 48;
    const perBigNet = u.perBigNet ?? 4;
    const cidrs = [];
    for (const s of sections) { if (Array.isArray(json[s])) { cidrs.push(...json[s]); } }
    // /32 优先：那些才是 GitHub 实际在用的入口；大段采样只是补充
    const singles = cidrs.filter((c) => String(c).endsWith("/32")).flatMap((c) => expandCidr(c));
    const bigs = cidrs.filter((c) => !String(c).endsWith("/32")).flatMap((c) => expandCidr(c, perBigNet));
    const ips = [...new Set([...singles, ...bigs])].slice(0, maxIps);

    const cache = { at: new Date().toISOString(), lastAttempt: attemptedAt, via, sections, count: ips.length, ips };
    writePoolCache(cache);
    log(`池已更新：${ips.length} 个 IP（via ${via}，段 ${sections.join("+")}）`);
    return { ok: true, count: ips.length, via, path: poolCachePath() };
  } catch (e) {
    writePoolCache({ ...(prev || {}), lastAttempt: attemptedAt, lastError: String(e.message || e) });
    throw e;
  }
}

// 是否该更新。🔴 **成功与失败用同一档冷却**（intervalHours，默认 24h）：
// 拉 meta 走的是 api.github.com —— 如果它被 SNI 层封锁，换任何 IP 都救不回，
// 那种情况下反复重试毫无意义（还白撞 60 次/小时的 API 限制），所以失败后也等满一个周期再说。
// 手动更新不受此限制：`ghprobe update-pool` 永远立即执行。
export function poolNeedsUpdate(cfg) {
  if (cfg.poolUpdate?.enabled === false) { return false; }
  const intervalH = cfg.poolUpdate?.intervalHours ?? 24;
  const c = readPoolCache();
  const now = Date.now();
  const fresh = (ts) => ts && now - new Date(ts).getTime() < intervalH * 3600_000;
  if (fresh(c?.at)) { return false; }           // 成功过，没到点
  if (fresh(c?.lastAttempt)) { return false; }  // 尝试过（成功或失败），没到点
  return true;
}
