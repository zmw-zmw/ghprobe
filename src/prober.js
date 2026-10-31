// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 zmw
// 三关探测：TCP RTT -> TLS 握手 + 证书域名校验 -> HTTP 应用层终审
// 证书校验拦的是 DNS 污染，应用层终审拦的是共享 CDN 上未部署该域名的"假活"IP
import tls from "node:tls";
import https from "node:https";
import net from "node:net";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";

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
  // api.github.com：gh CLI / REST API 走它，DNS 同样被污染。判据用 /rate_limit：
  // 未认证也返回 200，响应体是 JSON 且必含 "rate" 字段 —— 不依赖 GitHub 网页特征
  "api.github.com": {
    path: "/rate_limit",
    mustContain: ["rate"],
    allow: [200, 204],
    reject: ["unknown domain", "Fastly error", "bad request"],
    redirectHosts: [],
  },
  "github.com": {
    path: "/",
    mustContain: ["github"],
    // 只留 2xx/3xx：根路径必须真的返回 GitHub 首页（或跳转到 github.com）
    allow: [200, 204, 301, 302, 303, 304, 307, 308],
    reject: ["unknown domain", "Fastly error", "bad request"],
    redirectHosts: ["github.com"],
  },
  // github.githubassets.com：github.com 网页的全部 JS/CSS/字体都从这里加载（0.3.0 新增）。
  // 它不写进 hosts 时「页面能打开但样式全裂」，是直连浏览最常见的体验杀手。
  // 判据用 favicon（2026-10-31 实测 4 个 Fastly .215 IP 全部 200 且以 `<svg` 开头）；
  // 注意它的 Fastly 段是 185.199.108-111.**215**，与 githubusercontent 系的 .133 不同段
  // （.133 对该 SNI 直接连接失败），所以 domainPools 走独立的 ghassets 池。
  "github.githubassets.com": {
    path: "/favicons/favicon.svg",
    mustContain: ["<svg"],
    allow: [200, 204],
    reject: ["unknown domain", "Fastly error", "bad request"],
    redirectHosts: [],
  },
  // ssh.github.com：SSH-over-443 端点（git clone git@ssh.github.com:... 用，0.3.0 新增）。
  // type:"ssh" —— 不走 TLS/HTTP 三关，改探 SSH banner（见 sshProbe）。
  "ssh.github.com": { type: "ssh" },
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
    // 🔴 路径必须带分支段（2026-10-31 实测修正）：raw.githubusercontent.com 的第 2 段是
    //    分支名，`/torvalds/linux/README.md` 会被当作「README.md 分支」返回 404 ——
    //    就算网络全通也会被判死（假阴性）。正确形态 `/torvalds/linux/master/README`
    //    实测 200 且响应体含 "Linux kernel"（linux 仓库根文件本来就叫 README，无 .md）。
    path: "/torvalds/linux/master/README",
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
  // cdn.jsdelivr.net：0.4.0 起已从默认兜底链移除（2026-10-31 实测 SNI 级硬封：
  // node + 双 curl 共 45 次全部在 ClientHello 后被 RST，换 IP/换 TLS 栈均无效）。
  // 判据保留在这里：老用户配置里若仍引用它，探测依然有正确的业务路径可用。
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
function tcpTlsProbe(ip, domain, tcpMs, tlsMs, port = 443) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    let tcpCost = -1;
    let stage = "tcp";
    const sock = tls.connect({ host: ip, port, servername: domain, rejectUnauthorized: true });
    const done = (r) => { try { sock.destroy(); } catch { /* 已销毁 */ } resolve(r); };
    sock.setTimeout(tcpMs, () => done({ ok: false, stage, err: "timeout" }));
    sock.on("connect", () => { tcpCost = Date.now() - t0; stage = "tls"; sock.setTimeout(tlsMs); });
    sock.on("secureConnect", () => done({ ok: true, tcpMs: tcpCost, tlsMs: Date.now() - t0 }));
    sock.on("error", (e) => done({ ok: false, stage, err: String(e.code || e.message).slice(0, 60) }));
  });
}

// SSH banner 探测（type:"ssh" 的域名走这条，如 ssh.github.com 的 SSH-over-443）：
// 服务端**先**发 banner（SSH-2.0-...），客户端 TLS/HTTP 三关都不适用 —— 读到合法 banner 即活。
// 超时复用 tcpMs：SSH banner 在 TCP 建连后立刻到，不需要单独一档。
export function parseSshBanner(buf) {
  const s = String(buf.slice(0, 255));
  const nl = s.indexOf("\r\n");
  if (nl === -1) { return null; }
  const line = s.slice(0, nl);
  return /^SSH-\d\.\d-.+\r?$/.test(line) ? line : "";
}

export function sshProbe(ip, tcpMs, port = 443) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    let tcpCost = -1;
    let settled = false;
    let acc = Buffer.alloc(0);
    const sock = net.connect({ host: ip, port });
    const done = (r) => {
      if (settled) { return; }
      settled = true;
      try { sock.destroy(); } catch { /* 已销毁 */ }
      resolve(r);
    };
    sock.setTimeout(tcpMs, () => done({ ok: false, stage: tcpCost < 0 ? "tcp" : "banner", err: "timeout" }));
    sock.on("connect", () => { tcpCost = Date.now() - t0; });
    sock.on("data", (c) => {
      acc = Buffer.concat([acc, c]);
      const banner = parseSshBanner(acc);
      if (banner) { done({ ok: true, tcpMs: tcpCost, banner: banner.slice(0, 48), err: "" }); }
      else if (banner === "") { done({ ok: false, stage: "banner", err: "not ssh" }); }
      else if (acc.length >= 255) { done({ ok: false, stage: "banner", err: "not ssh" }); }
    });
    sock.on("timeout", () => done({ ok: false, stage: tcpCost < 0 ? "tcp" : "banner", err: "timeout" }));
    sock.on("error", (e) => done({ ok: false, stage: tcpCost < 0 ? "tcp" : "banner", err: String(e.code || e.message).slice(0, 60) }));
    sock.on("close", () => done({ ok: false, stage: tcpCost < 0 ? "tcp" : "banner", err: "closed" }));
  });
}

// 🔴 schannel 二次探测：Node 的 TLS ClientHello 形态会被中间设备识别并 RST（README §3 实测：
//    同一 IP 同一时刻 openssl 20/20、Node 5/20、浏览器正常）。Windows 10+ **自带**的
//    curl.exe 是 Schannel 构建 —— 与 Edge 同一 TLS 栈，指纹与浏览器一致。
//    被节点侧 TLS 阻断的候选用它重探一次：能给出「与浏览器一致」的真实判定，
//    而不是把「浏览器明明能用」的域名写成 # blocked。
// 🔴 必须显式定位 System32 的 curl.exe：PATH 里排在前面的可能是 Git 自带的 OpenSSL 构建
//    （实测 mingw64 curl 走 OpenSSL，指纹又变回去了）。找不到就返回 null，退回旧行为。
export function findSystemCurl() {
  if (process.platform !== "win32") { return ""; }
  const p = path.join(process.env.SystemRoot || "C:\\Windows", "System32", "curl.exe");
  return fs.existsSync(p) ? p : "";
}

// 一次 schannel 探测：curl --resolve 把域名钉到候选 IP，-m 限时。
// 返回 { ok, status, tlsMs, ttfb, err }；连接层失败（含 TLS 被 reset）status=-1。
// opts = { exec, curl, port } 可注入（单测不打真网络）。
export function curlSchannelProbe(ip, domain, cfg, opts = {}) {
  const curl = opts.curl ?? findSystemCurl();
  if (!curl) { return Promise.resolve(null); }
  const exec = opts.exec || execFile;
  const sig = sigFor(domain, cfg);
  const httpMs = Math.max(2000, cfg.timeouts.httpMs);
  const port = opts.port ?? 443;
  return new Promise((resolve) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ghprobe-curl-"));
    const body = path.join(dir, "body");
    exec(curl, [
      "-sS", "-o", body, "--resolve", `${domain}:${port}:${ip}`,
      "-m", String(Math.round(httpMs / 1000)),
      "-w", "%{http_code} %{time_appconnect} %{time_starttransfer}",
      `https://${domain}:${port}${sig.path}`,
    ], { timeout: httpMs + 4000, windowsHide: true }, (e, stdout, stderr) => {
      let out = { ok: false, status: -1, tlsMs: -1, ttfb: -1, err: "" };
      if (e) {
        const msg = String(stderr || e.message).trim().split(/\r?\n/)[0].slice(0, 60);
        out = { ok: false, status: -1, tlsMs: -1, ttfb: -1, err: `schannel:${msg || "failed"}` };
      } else {
        const parts = String(stdout).trim().split(/\s+/);
        const statusCode = Number(parts[0]) || -1;
        let bodyText = "";
        try { bodyText = fs.readFileSync(body, "utf8").slice(0, 4096); } catch { /* 空响应体 */ }
        const checked = checkHttpResponse(statusCode, bodyText, "", sig);
        // 跳转校验弱化：curl 未跟随跳转、也没取回 Location 头，3xx 交给 allow 列表判。
        // 只在 TLS 已经通过 schannel 之后才会走到这，风险可接受（README §3 的假活是 HTTP 层的）。
        out = {
          ok: checked.ok, status: statusCode,
          tlsMs: Math.round(Number(parts[1]) * 1000) || -1,
          ttfb: Math.round(Number(parts[2]) * 1000) || -1,
          err: checked.ok ? "" : `http:${checked.err}`,
        };
      }
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* 清理失败不管 */ }
      resolve(out);
    });
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
function httpProbe(ip, domain, httpMs, cfg, port = 443) {
  return new Promise((resolve) => {
    const sig = sigFor(domain, cfg);
    const t0 = Date.now();
    const req = https.request({
      host: ip, port, servername: domain, method: "GET", path: sig.path, timeout: httpMs,
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

// 探测单个 (域名, IP)：三关全过才算活；分数越小越优。
// deps = { curlProbe, port } 可注入（单测把 port 指到本地服务，不打真网络），
// 缺省 curlProbe 用 curlSchannelProbe、端口 443。
// 两条扩展路径：
//   ① type:"ssh" 的域名（ssh.github.com）不跑 TLS/HTTP 三关，读 SSH banner 判活；
//   ② TLS 阶段被指纹阻断时（TCP 通、TLS 被 reset），用 Windows 自带 curl（schannel，
//      与浏览器同一 TLS 栈）重探一次 —— 0.3.0 前这种情况只能写 # blocked 放弃，
//      而「浏览器明明能用」的域名就这样被误判成不可达。重探也失败时：
//      HTTP 层有响应 = TLS 其实通了（假活，不是指纹问题，不标 blocked）；
//      连接层仍失败 = 连浏览器同款栈都过不去，才是真被阻断。
export async function probeIp(domain, ip, cfg, deps = {}) {
  const { tlsMs, httpMs } = cfg.timeouts;
  const tcpMs = cfg.timeouts.tcpMs ?? tlsMs; // 老配置没这一项时退回 tlsMs，行为不变
  const port = deps.port ?? 443;
  const sig = sigFor(domain, cfg);

  if (sig.type === "ssh") {
    const g = await sshProbe(ip, tcpMs, port);
    return g.ok
      ? { domain, ip, ok: true, tcpMs: g.tcpMs, tlsMs: g.tcpMs, ttfb: g.tcpMs, status: 0, score: g.tcpMs, banner: g.banner, err: "", via: "ssh" }
      : { domain, ip, ok: false, stage: g.stage, err: g.err };
  }

  const g = await tcpTlsProbe(ip, domain, tcpMs, tlsMs, port);
  if (!g.ok) {
    if (looksLikeTlsBlocked(g) && cfg.probe?.schannelRetry !== false) {
      const s = await (deps.curlProbe || curlSchannelProbe)(ip, domain, cfg, { port });
      if (s) {
        if (s.ok) {
          const tcp = g.tcpMs >= 0 ? g.tcpMs : s.tlsMs;
          const tlsCost = s.tlsMs > 0 ? s.tlsMs : 0;
          const score = Math.round(tcp * 0.4 + tlsCost * 0.4 + (s.ttfb > 0 ? s.ttfb : httpMs) * 0.2);
          return {
            domain, ip, ok: true, tcpMs: tcp, tlsMs: tcp + tlsCost,
            ttfb: s.ttfb, status: s.status, score, via: "schannel", err: "",
          };
        }
        return { domain, ip, ok: false, stage: s.status > 0 ? "http" : "tls", err: s.err, tlsBlocked: !(s.status > 0), via: "schannel" };
      }
    }
    return { domain, ip, ok: false, stage: g.stage, err: g.err, tlsBlocked: looksLikeTlsBlocked(g) };
  }
  const h = await httpProbe(ip, domain, httpMs, cfg, port);
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
