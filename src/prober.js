// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 zmw
// 三关探测：TCP RTT -> TLS 握手 + 证书域名校验 -> HTTP 应用层终审
// 证书校验拦的是 DNS 污染，应用层终审拦的是共享 CDN 上未部署该域名的"假活"IP
import tls from "node:tls";
import https from "node:https";

// 目标域名的应用层指纹：真实业务路径、必须包含的响应特征、允许状态码、拒绝特征、允许跳转的 host
// 路径必须能代表真实业务；codeload 用归档下载路径，避免根路径 301 到 github.com 主站骗过校验
//
// 🔴 状态码白名单的取舍（2026-10-11 实测踩坑）：
//    白名单里放 4xx 等于给「不服务该域名的假活 IP」发通行证 —— 它们 TCP/TLS 都通、
//    证书也合法（同属 GitHub 的 CDN），但 HTTP 层对所有路径回 4xx。实测
//    `20.205.243.161` 对 github.com 的 `/`、`/login` 全回 **400**，响应体还是
//    **GitHub 自己的错误页**（`<title>Bad request &middot; GitHub</title>`）——
//    于是 `mustContain:["github"]` 也命中，三道判据全部放行，该 IP 被排到第 1 名写进 hosts，
//    用户拿到 400。更糟的是「同名多条目 fallback」兜不住它：**400 是合法 HTTP 响应，
//    不是连接失败，客户端不会回退到备选**。
//    → 规则：**路径 `/` 只接受 200/3xx**。只有那些「根路径本来就不存在合法内容」的域名
//    （objects 根路径是 Varnish 的 404、gist 是 301）才保留 4xx，且靠 reject 词表兜底。
export const DOMAIN_SIG = {
  "github.com": {
    path: "/",
    mustContain: ["github"],
    // 只留 2xx/3xx：根路径必须真的返回 GitHub 首页（或跳转到 github.com）
    allow: [200, 204, 301, 302, 303, 304, 307, 308],
    reject: ["unknown domain", "Fastly error", "bad request"],
    redirectHosts: ["github.com"],
  },
  "codeload.github.com": {
    path: "/torvalds/linux/tar.gz/refs/heads/master",
    mustContain: [],
    allow: [200, 204, 302, 303, 304, 307, 308],
    reject: ["unknown domain", "Fastly error", "bad request"],
    redirectHosts: ["codeload.github.com", "objects.githubusercontent.com"],
  },
  "objects.githubusercontent.com": {
    // ⚠️ 根路径必然 404（实测 Varnish 返回纯 "404 Not Found"，响应体里没有 "github"），
    //    所以这里无法用 mustContain 兜底，4xx 必须留在白名单里 —— 是已知的判据弱点，
    //    实际靠 reject 词表（unknown domain / Fastly error）拦假活节点。
    path: "/",
    mustContain: [],
    allow: [200, 204, 302, 303, 304, 307, 308, 400, 401, 403, 404],
    reject: ["unknown domain", "Fastly error", "bad request"],
    redirectHosts: ["objects.githubusercontent.com"],
  },
  "raw.githubusercontent.com": {
    path: "/torvalds/linux/README.md",
    mustContain: ["Linux kernel"],
    allow: [200, 204, 302, 303, 304, 307, 308],
    reject: ["unknown domain", "Fastly error", "bad request"],
    redirectHosts: ["raw.githubusercontent.com", "objects.githubusercontent.com"],
  },
  "gist.githubusercontent.com": {
    path: "/",
    mustContain: [],
    allow: [200, 204, 301, 302, 303, 304, 307, 308, 400, 401, 403, 404],
    reject: ["unknown domain", "Fastly error", "bad request"],
    redirectHosts: ["gist.githubusercontent.com", "gist.github.com"],
  },
  "avatars.githubusercontent.com": {
    path: "/u/1?v=4",
    mustContain: [],
    allow: [200, 204, 302, 303, 304, 307, 308],
    reject: ["unknown domain", "Fastly error", "bad request"],
    redirectHosts: ["avatars.githubusercontent.com"],
  },
  "cdn.jsdelivr.net": {
    path: "/gh/torvalds/linux@master/README",
    mustContain: ["Linux kernel"],
    allow: [200, 204, 301, 302, 303, 304, 307, 308],
    reject: ["unknown domain", "Fastly error", "bad request"],
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

// 一条 TLS 连接同时量出 TCP 与 TLS 两段耗时。
// 🔴 两段必须用**各自的超时**：黑洞 IP 的 TCP 握手会一直挂到超时，若统一用 tlsMs(6s)，
//    十几条死候选就是几十秒 —— 池子因此不敢放宽，进而出现「明明有活 IP 却报 stuck」。
//    这里先按 tcpMs 计，握手成功（connect 事件）后再把超时切到 tlsMs：
//    快速淘汰死 IP，同时不误杀「连得上但 TLS 慢」的活 IP。
function tcpTlsProbe(ip, domain, tcpMs, tlsMs) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    let tcpCost = -1;
    let stage = "tcp";
    const sock = tls.connect({ host: ip, port: 443, servername: domain, rejectUnauthorized: true });
    const done = (r) => { try { sock.destroy(); } catch { /* 已销毁 */ } resolve(r); };
    sock.setTimeout(tcpMs, () => done({ ok: false, stage, err: "timeout" }));
    sock.on("connect", () => { tcpCost = Date.now() - t0; stage = "tls"; sock.setTimeout(tlsMs); });
    sock.on("secureConnect", () => done({ ok: true, tcpMs: tcpCost, tlsMs: Date.now() - t0 }));
    sock.on("error", (e) => done({ ok: false, stage, err: String(e.code || e.message).slice(0, 60) }));
  });
}

// 读取响应体前 n 字节，用于特征校验；读够后立即断开，不下载完整大页面
function readPrefix(res, maxBytes) {  return new Promise((resolve) => {
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

// 未在 DOMAIN_SIG 里声明、也没有配置判据时的兜底判据
const DEFAULT_SIG = {
  path: "/",
  mustContain: [],
  allow: [200, 204, 301, 302, 303, 304, 307, 308],
  reject: ["unknown domain", "Fastly error", "bad request"],
  redirectHosts: [],
};

// 取某域名的探测判据：**配置里 fallbackSigs 声明的优先于代码里的 DOMAIN_SIG**。
// 🔴 为什么替身域名必须能自带判据：不同替身服务的 URL 形态不同 ——
//    CDN 映射是 `/gh/<user>/<repo>@<ref>/<path>`，代理是 `/<完整原始 URL>` ——
//    判据没法写死在代码里，用户新增一个替身也不该被要求改源码。
export function sigFor(domain, cfg) {
  const override = cfg?.fallbackSigs?.[domain];
  const base = DOMAIN_SIG[domain];
  if (!base && !override) { return DEFAULT_SIG; }
  return { ...DEFAULT_SIG, ...(base || {}), ...(override || {}) };
}

// 第三关：HTTP GET（host=IP、SNI=域名、Host头=域名），读少量响应体做终审
function httpProbe(ip, domain, httpMs, cfg) {
  return new Promise((resolve) => {
    const sig = sigFor(domain, cfg);
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

// 🔴 区分两类失败（2026-10-11 实测）：
//   ① stage=tcp  —— TCP 握手就没成功（超时 / 拒绝）-> 这个 IP 确实不可用
//   ② stage=tls  —— **TCP 连上了，但 TLS 阶段被重置或永远不完成** -> 很可能不是 IP 的问题，
//      而是本机 TLS 指纹被中间设备识别后掐断（DPI 按 ClientHello 的形态放行/拦截）。
//
//   为什么必须区分：实测同一 IP、同一 SNI、同一时刻 ——
//     openssl s_client 20/20 握手成功，node tls.connect 5/20，curl 3/20；
//     而浏览器（Edge）能正常打开同一个 URL。
//   ghprobe 自己就是 Node，**它的探测客户端指纹和用户的浏览器不同** ——
//   把 ② 判成「IP 不可用」会把「浏览器其实能用」的域名误记成不可达（假阴性），
//   还会写进 `# absent` 冷却让工具主动放弃它。
const RESET_RE = /ECONNRESET|EPIPE|ECONNABORTED|socket hang up|Client network socket disconnected/i;
export function looksLikeTlsBlocked(failure) {
  if (!failure || failure.ok || failure.stage !== "tls") { return false; }
  const err = String(failure.err || "");
  return RESET_RE.test(err) || err === "timeout";
}

// 探测单个 (域名, IP)：三关全过才算活；分数越小越优
export async function probeIp(domain, ip, cfg) {
  const { tlsMs, httpMs } = cfg.timeouts;
  const tcpMs = cfg.timeouts.tcpMs ?? tlsMs; // 老配置没这一项时退回 tlsMs，行为不变
  const g = await tcpTlsProbe(ip, domain, tcpMs, tlsMs);
  if (!g.ok) {
    return { domain, ip, ok: false, stage: g.stage, err: g.err, tlsBlocked: looksLikeTlsBlocked(g) };
  }
  const h = await httpProbe(ip, domain, httpMs, cfg);
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
