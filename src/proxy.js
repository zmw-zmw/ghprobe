// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 zmw
// 本地代理共存（0.1.7）：检测本机代理 + 经代理隧道探测候选 IP。
//
// 为什么需要：不少用户是「代理 + ghprobe」混用 —— 代理在跑时流量走代理（hosts 不影响它），
// 代理一停流量落回直连（hosts 成了唯一救命稻草）。ghprobe 此前对代理一无所知，有两个亏：
//   ① 直连探活偶尔被本机链路抖动误判成「IP 死了」，触发一轮无谓的换 IP（抖动窗口里换谁
//      都一样烂，纯打扰）；此时问一句代理「这 IP 从你那边看活不活」就能避免误判 ——
//      代理出口在境外，它说活 = IP 全局没死 = 本机直连链路的问题，不值得切。
//   ② 代理停止的瞬间流量落回直连，恰恰是 hosts 最要好的时刻 —— daemon 检测到
//      「存活 -> 死亡」跃迁就立即全量重测直连（见 daemon.js 的 proxyDeathReprobe）。
//
// 只支持 **HTTP CONNECT 代理**（Clash / v2rayN / ssr 等本地客户端都带 HTTP 端口）。
// SOCKS 专线端口不支持（不想手写 SOCKS 握手），检测到 socks-only 的系统代理时明确跳过。
//
// 检测顺序：环境变量 -> Windows 系统代理（注册表，免管理员）-> 常见本地端口扫描。
// 每一层都要求最终用 `CONNECT github.com:443` 实测「经此代理可达 GitHub」才算 alive ——
// 端口开着不等于代理可用（可能挂了、可能规则里根本不放行 GitHub）。
import net from "node:net";
import tls from "node:tls";
import { execFile } from "node:child_process";

export const PROXY_TEST_HOST = "github.com";

// ---------- 纯解析 ----------

// 解析代理端点："127.0.0.1:7890" / "localhost:7890" / "http://127.0.0.1:7890" /
// "http://user:pass@127.0.0.1:7890"。socks:// 明确返回 null（CONNECT 隧道只走 HTTP 代理）。
export function parseProxyEndpoint(raw) {
  const s = String(raw || "").trim();
  if (!s) { return null; }
  if (/^socks(?:4|4a|5|h)?:/i.test(s)) { return null; }
  const m = s.match(/^(?:https?|tls|ssl):\/\/(?:[^/@]*@)?([\w.\-]+):(\d{1,5})/i)
    || s.match(/^([\w.\-]+):(\d{1,5})$/);
  if (!m) { return null; }
  const port = parseInt(m[2], 10);
  if (!(port > 0 && port <= 65535)) { return null; }
  return { host: m[1], port };
}

// 解析 `reg query HKCU\...\Internet Settings` 输出里的系统代理。
// ProxyServer 三种形态：`127.0.0.1:7890`（整体代理）/ `http=...;https=...;socks=...`
// （分协议）。分协议时**优先 https=**（CONNECT 隧道走 443，语义最贴），没有再用 http=；
// socks-only 明确跳过（连不上 CONNECT 隧道）。ProxyEnable 不是 0x1 时直接 null。
export function parseSystemProxy(regOutput) {
  const out = String(regOutput || "");
  if (!/\bProxyEnable\s+REG_DWORD\s+0x1\b/i.test(out)) { return null; }
  const m = out.match(/\bProxyServer\s+REG_SZ\s+(\S+)/i);
  if (!m) { return null; }
  const v = m[1];
  if (v.includes("=")) {
    const parts = v.split(";").map((p) => p.match(/^\s*(https?|socks(?:4|4a|5|h)?)\s*=\s*(.+?)\s*$/i)).filter(Boolean);
    for (const want of ["https", "http"]) { // 两轮挑选：先 https 后 http，别被顺序带着走
      const hit = parts.find((pm) => pm[1].toLowerCase() === want);
      if (hit) { return parseProxyEndpoint(hit[2]); }
    }
    return null; // 只有 socks 分协议条目 —— 不支持
  }
  return parseProxyEndpoint(v);
}

// 环境变量优先级：HTTPS_PROXY > https_proxy > ALL_PROXY > all_proxy > HTTP_PROXY > http_proxy
export function proxyFromEnv(env = process.env) {
  for (const k of ["HTTPS_PROXY", "https_proxy", "ALL_PROXY", "all_proxy", "HTTP_PROXY", "http_proxy"]) {
    const ep = parseProxyEndpoint(env[k]);
    if (ep) { return { ...ep, kind: "env", env: k }; }
  }
  return null;
}

// ---------- 隧道 ----------

// 经 HTTP 代理建 CONNECT 隧道到 targetHost:targetPort。返回 { ok, rttMs, err, socket }。
// 成功时调用方负责拿 socket（probeThroughProxy 拿去做 TLS）；失败时 socket 已销毁。
// opts = { netConnect, timeoutMs } 可注入（单测替身）。
export function connectProxyTunnel(proxy, targetHost, targetPort, opts = {}) {
  const timeoutMs = opts.timeoutMs ?? 2500;
  return new Promise((resolve) => {
    const t0 = Date.now();
    let acc = "";
    const sock = (opts.netConnect || net.connect)({ host: proxy.host, port: proxy.port });
    const done = (r) => {
      try { sock.destroy(); } catch { /* 已销毁 */ }
      resolve(r);
    };
    const timer = setTimeout(() => done({ ok: false, rttMs: -1, err: "tunnel timeout", socket: null }), timeoutMs);
    sock.on("connect", () => {
      sock.write(`CONNECT ${targetHost}:${targetPort} HTTP/1.1\r\nHost: ${targetHost}:${targetPort}\r\nUser-Agent: ghprobe\r\n\r\n`);
    });
    sock.on("data", (c) => {
      acc += c.toString("latin1");
      const end = acc.indexOf("\r\n\r\n");
      if (end === -1) { return; }
      clearTimeout(timer);
      const status = parseInt((acc.split("\r\n")[0] || "").split(" ")[1], 10);
      if (status === 200) {
        // 隧道已建立：把 socket 交给调用方继续 TLS。接管前先摘掉 data 监听，
        // 防止后续 TLS 字节被当成 HTTP 响应头再次解析。
        sock.removeAllListeners("data");
        sock.removeAllListeners("error");
        sock.removeAllListeners("close");
        sock.removeAllListeners("timeout");
        resolve({ ok: true, rttMs: Date.now() - t0, err: "", socket: sock });
      } else {
        done({ ok: false, rttMs: Date.now() - t0, err: `proxy status ${status || "?"}`, socket: null });
      }
    });
    sock.on("error", (e) => { clearTimeout(timer); done({ ok: false, rttMs: -1, err: String(e.code || e.message).slice(0, 60), socket: null }); });
    sock.on("close", () => { clearTimeout(timer); done({ ok: false, rttMs: -1, err: "closed", socket: null }); });
    sock.on("timeout", () => { clearTimeout(timer); done({ ok: false, rttMs: -1, err: "tunnel timeout", socket: null }); });
    sock.setTimeout(timeoutMs);
  });
}

// 经代理测一个候选 IP：CONNECT <ip>:443 建隧道 -> 隧道里对 IP 做 TLS 握手（SNI=域名、
// 证书校验照常）。TLS 过了 = 这个 IP 从代理出口视角全局可用（证书都验得过，假不了）。
// 与直连 probe 的 tcpTlsProbe 同构：tunnelMs 管 TCP+CONNECT，tlsMs 管握手。
// opts = { netConnect, tlsConnect, tunnelMs, tlsMs } 可注入（单测替身）。
export function probeThroughProxy(ip, domain, cfg, proxy, opts = {}) {
  const tunnelMs = opts.tunnelMs ?? cfg.proxy?.connectTimeoutMs ?? 2500;
  const tlsMs = opts.tlsMs ?? cfg.timeouts?.tlsMs ?? 6000;
  return new Promise((resolve) => {
    const t0 = Date.now();
    let settled = false;
    const finish = (r) => { if (!settled) { settled = true; resolve(r); } };
    connectProxyTunnel(proxy, ip, 443, { netConnect: opts.netConnect, timeoutMs: tunnelMs }).then((t) => {
      if (settled) { return; }
      if (!t.ok) { finish({ ok: false, stage: "tunnel", err: t.err }); return; }
      const tlsSock = (opts.tlsConnect || tls.connect)({
        socket: t.socket, servername: domain, rejectUnauthorized: true,
      });
      const tlsTimer = setTimeout(() => {
        try { tlsSock.destroy(); } catch { /* 已销毁 */ }
        finish({ ok: false, stage: "tls", err: "tls timeout" });
      }, tlsMs);
      tlsSock.on("secureConnect", () => {
        clearTimeout(tlsTimer);
        try { tlsSock.destroy(); } catch { /* 已销毁 */ }
        finish({ ok: true, stage: "tls", rttMs: Date.now() - t0, err: "" });
      });
      tlsSock.on("error", (e) => {
        clearTimeout(tlsTimer);
        try { tlsSock.destroy(); } catch { /* 已销毁 */ }
        finish({ ok: false, stage: "tls", err: String(e.code || e.message).slice(0, 60) });
      });
    }).catch(() => finish({ ok: false, stage: "tunnel", err: "tunnel error" }));
  });
}

// ---------- 检测 ----------

// 本地端口扫描（并行）：谁先接受 TCP 谁就是候选端点。只在 env / 系统代理都没找到时才跑。
// deps.tryConnect 可注入（单测不打真端口）。
export function scanLocalPorts(ports, timeoutMs = 400, deps = {}) {
  const list = (ports || []).map((p) => parseInt(p, 10)).filter((p) => p > 0 && p <= 65535);
  const tryConnect = deps.tryConnect
    || ((host, port, ms) => new Promise((resolve) => {
      const s = net.connect({ host, port });
      const t = setTimeout(() => { try { s.destroy(); } catch { /* 忽略 */ } resolve(false); }, ms);
      s.on("connect", () => { clearTimeout(t); try { s.destroy(); } catch { /* 忽略 */ } resolve(true); });
      s.on("error", () => { clearTimeout(t); resolve(false); });
    }));
  return Promise.all(list.map(async (port) => {
    const hit = await tryConnect("127.0.0.1", port, timeoutMs);
    return hit ? { host: "127.0.0.1", port, kind: "port-scan" } : null;
  })).then((rs) => rs.find(Boolean) || null);
}

// 读 Windows 系统代理（reg query，免管理员、无窗口）。deps.exec 可注入。
export function readSystemProxy(deps = {}) {
  if (process.platform !== "win32") { return Promise.resolve(null); }
  const exec = deps.exec || execFile;
  return new Promise((resolve) => {
    exec("reg", [
      "query", "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings",
      "/v", "ProxyEnable",
    ], { windowsHide: true, timeout: 3000 }, (e1, o1) => {
      if (e1 || !/0x1/.test(String(o1))) { resolve(null); return; }
      exec("reg", [
        "query", "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings",
        "/v", "ProxyServer",
      ], { windowsHide: true, timeout: 3000 }, (e2, o2) => {
        if (e2) { resolve(null); return; }
        const ep = parseSystemProxy(o2);
        resolve(ep ? { ...ep, kind: "system" } : null);
      });
    });
  });
}

// 只做**本地**检测（env / 注册表 / 端口扫描），不碰网络 —— status 的「不打网络请求」承诺不破。
// 每层命中都要再过一遍「socks-only 排除」：parseProxyEndpoint 对 socks 返回 null。
export async function detectProxyEndpoint(cfg, deps = {}) {
  if (cfg.proxy?.enabled === false) { return null; }
  const env = proxyFromEnv(deps.env || process.env);
  if (env) { return env; }
  const sys = deps.readSystemProxy ? await deps.readSystemProxy() : await readSystemProxy(deps);
  if (sys) { return sys; }
  return scanLocalPorts(cfg.proxy?.ports, cfg.proxy?.portScanTimeoutMs ?? 400, deps);
}

// 完整检测：端点 + 「经它可达 GitHub」实测。结果短缓存（daemon 15~45s 一轮，
// 每轮一次 CONNECT 足够，同进程内的重复调用走缓存）。
// deps = { exec, env, tryConnect, netConnect, now } 可注入（单测不打真网络）。
let _cache = { at: 0, result: null };
export async function detectProxy(cfg, deps = {}) {
  const cacheMs = cfg.proxy?.cacheMs ?? 30_000;
  const now = deps.now ?? Date.now();
  if (!deps.noCache && _cache.result && now - _cache.at < cacheMs) {
    return { ..._cache.result, cached: true };
  }
  const endpoint = await detectProxyEndpoint(cfg, deps);
  if (!endpoint) {
    const r = { found: false, alive: false, reason: "未检测到本地代理", cached: false };
    _cache = { at: now, result: r };
    return r;
  }
  const t = await connectProxyTunnel(endpoint, PROXY_TEST_HOST, 443, {
    netConnect: deps.netConnect, timeoutMs: cfg.proxy?.connectTimeoutMs ?? 2500,
  });
  // 只验证可达性，隧道不用了就关 —— 不关的话每次检测漏一条到代理的长连接
  if (t.ok && t.socket) { try { t.socket.destroy(); } catch { /* 已销毁 */ } }
  const r = {
    found: true, alive: t.ok,
    ...endpoint,
    rttMs: t.ok ? t.rttMs : -1,
    reason: t.ok ? "经代理可达 GitHub" : `代理端点无响应（${t.err}）`,
    cached: false,
  };
  _cache = { at: now, result: r };
  return r;
}

// 测试用：清掉模块级检测缓存
export function resetProxyCache() { _cache = { at: 0, result: null }; }
