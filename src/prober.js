// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 zmw
// 三关探测：TCP RTT -> TLS 握手 + 证书域名校验 -> HTTP 应用层终审
// 证书校验拦的是 DNS 污染，应用层终审拦的是共享 CDN 上未部署该域名的"假活"IP
import tls from "node:tls";
import https from "node:https";

// 目标域名的应用层指纹：真实业务路径、必须包含的响应特征、允许状态码、拒绝特征、允许跳转的 host
// 路径必须能代表真实业务；codeload 用归档下载路径，避免根路径 301 到 github.com 主站骗过校验
export const DOMAIN_SIG = {
  "github.com": {
    path: "/",
    mustContain: ["github"],
    allow: [200, 204, 301, 302, 303, 304, 307, 308, 400, 401, 403, 404],
    reject: ["unknown domain", "Fastly error"],
    redirectHosts: ["github.com"],
  },
  "codeload.github.com": {
    path: "/torvalds/linux/tar.gz/refs/heads/master",
    mustContain: [],
    allow: [200, 204, 302, 303, 304, 307, 308],
    reject: ["unknown domain", "Fastly error"],
    redirectHosts: ["codeload.github.com", "objects.githubusercontent.com"],
  },
  "objects.githubusercontent.com": {
    path: "/",
    mustContain: [],
    allow: [200, 204, 302, 303, 304, 307, 308, 400, 401, 403, 404],
    reject: ["unknown domain", "Fastly error"],
    redirectHosts: ["objects.githubusercontent.com"],
  },
  "raw.githubusercontent.com": {
    path: "/torvalds/linux/README.md",
    mustContain: ["Linux kernel"],
    allow: [200, 204, 302, 303, 304, 307, 308],
    reject: ["unknown domain", "Fastly error"],
    redirectHosts: ["raw.githubusercontent.com", "objects.githubusercontent.com"],
  },
  "gist.githubusercontent.com": {
    path: "/",
    mustContain: [],
    allow: [200, 204, 301, 302, 303, 304, 307, 308, 400, 401, 403, 404],
    reject: ["unknown domain", "Fastly error"],
    redirectHosts: ["gist.githubusercontent.com", "gist.github.com"],
  },
  "avatars.githubusercontent.com": {
    path: "/u/1?v=4",
    mustContain: [],
    allow: [200, 204, 302, 303, 304, 307, 308],
    reject: ["unknown domain", "Fastly error"],
    redirectHosts: ["avatars.githubusercontent.com"],
  },
  "cdn.jsdelivr.net": {
    path: "/gh/torvalds/linux@master/README",
    mustContain: ["Linux kernel"],
    allow: [200, 204, 301, 302, 303, 304, 307, 308],
    reject: ["unknown domain", "Fastly error"],
    redirectHosts: ["cdn.jsdelivr.net", "www.jsdelivr.com", "jsdelivr.net"],
  },
};

// 3xx Location 跳到该域名不允许的 host（如 codeload 坏节点跳回 github.com 主站）则判死
// redirectHosts 未配置或为空数组时表示"不检查跳转"，避免兜底域名被误杀
function badRedirect(statusCode, location, sig) {
  if (!location || statusCode < 300 || statusCode >= 400) { return false; }
  const hosts = sig.redirectHosts;
  if (!hosts || hosts.length === 0) { return false; }
  let h;
  try { h = new URL(location).host; } catch { return false; }
  return !new Set(hosts).has(h);
}

// 一条 TLS 连接同时量出 TCP 与 TLS 两段耗时
function tcpTlsProbe(ip, domain, tlsMs) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    let tcpMs = -1;
    let stage = "tcp";
    const sock = tls.connect({ host: ip, port: 443, servername: domain, rejectUnauthorized: true });
    const done = (r) => { try { sock.destroy(); } catch { /* 已销毁 */ } resolve(r); };
    sock.setTimeout(tlsMs, () => done({ ok: false, stage, err: "timeout" }));
    sock.on("connect", () => { tcpMs = Date.now() - t0; stage = "tls"; });
    sock.on("secureConnect", () => done({ ok: true, tcpMs, tlsMs: Date.now() - t0 }));
    sock.on("error", (e) => done({ ok: false, stage, err: String(e.code || e.message).slice(0, 60) }));
  });
}

// 读取响应体前 n 字节，用于特征校验；读够后立即断开，不下载完整大页面
function readPrefix(res, maxBytes) {
  return new Promise((resolve) => {
    const chunks = [];
    let got = 0;
    let settled = false;
    const finish = () => {
      if (settled) { return; }
      settled = true;
      resolve(Buffer.concat(chunks).toString("utf8", 0, maxBytes));
    };
    res.on("data", (c) => {
      if (got < maxBytes) { chunks.push(c); }
      got += c.length;
      if (got >= maxBytes) { res.destroy(); finish(); }
    });
    res.on("end", finish);
    res.on("close", finish);
    res.on("error", finish);
  });
}

// 纯函数：给定状态码、响应体、Location，按域名指纹判定是否"真活"
export function checkHttpResponse(statusCode, body, location, sig) {
  const lower = String(body).toLowerCase();
  for (const bad of sig.reject) {
    if (lower.includes(bad.toLowerCase())) { return { ok: false, err: `reject:${bad}` }; }
  }
  if (badRedirect(statusCode, location, sig)) { return { ok: false, err: `redirect:${location}` }; }
  if (statusCode >= 500) { return { ok: false, err: `status:${statusCode}` }; }
  for (const need of sig.mustContain || []) {
    if (!lower.includes(need.toLowerCase())) { return { ok: false, err: `missing:${need}` }; }
  }
  if (sig.allow.includes(statusCode)) { return { ok: true, err: "" }; }
  return { ok: false, err: `status:${statusCode}` };
}

// 第三关：HTTP GET（host=IP、SNI=域名、Host头=域名），读少量响应体做终审
function httpProbe(ip, domain, httpMs) {
  return new Promise((resolve) => {
    const sig = DOMAIN_SIG[domain] || { path: "/", mustContain: [], allow: [200, 204, 301, 302, 303, 304, 307, 308, 400, 401, 403, 404], reject: ["unknown domain", "Fastly error"], redirectHosts: [] };
    const t0 = Date.now();
    const req = https.request({
      host: ip, servername: domain, method: "GET", path: sig.path, timeout: httpMs,
      headers: { Host: domain, "user-agent": "ghprobe/0.1.0", accept: "*/*" },
    }, async (res) => {
      const ttfb = Date.now() - t0;
      const body = await readPrefix(res, 4096);
      const checked = checkHttpResponse(res.statusCode, body, res.headers.location, sig);
      resolve({ ok: checked.ok, ttfb, status: res.statusCode, err: checked.err });
    });
    req.on("timeout", () => { req.destroy(); resolve({ ok: false, err: "timeout" }); });
    req.on("error", (e) => resolve({ ok: false, err: String(e.code || e.message).slice(0, 60) }));
    req.end();
  });
}

// 探测单个 (域名, IP)：三关全过才算活；分数越小越优
export async function probeIp(domain, ip, cfg) {
  const { tlsMs, httpMs } = cfg.timeouts;
  const g = await tcpTlsProbe(ip, domain, tlsMs);
  if (!g.ok) { return { domain, ip, ok: false, stage: g.stage, err: g.err }; }
  const h = await httpProbe(ip, domain, httpMs);
  const tlsCost = g.tlsMs - g.tcpMs;
  const score = Math.round(g.tcpMs * 0.4 + tlsCost * 0.4 + (h.ok ? h.ttfb : httpMs) * 0.2);
  return {
    domain, ip, ok: h.ok,
    tcpMs: g.tcpMs, tlsMs: g.tlsMs, ttfb: h.ok ? h.ttfb : -1, status: h.ok ? h.status : -1,
    score, err: h.ok ? "" : `http:${h.err}`,
  };
}

// 简单并发池：限制同时握手的 socket 数量
export async function pool(jobs, concurrency) {
  const out = new Array(jobs.length);
  let next = 0;
  const worker = async () => {
    for (;;) {
      const i = next++;
      if (i >= jobs.length) { return; }
      out[i] = await jobs[i]();
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, concurrency) }, worker));
  return out;
}
