// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 zmw
// prober 应用层终审单测：不连真实网络，只校验判定函数
import { test } from "node:test";
import assert from "node:assert/strict";
import { DOMAIN_SIG, checkHttpResponse, looksLikeTlsBlocked } from "../src/prober.js";

const gh = DOMAIN_SIG["github.com"];
const codeload = DOMAIN_SIG["codeload.github.com"];

test("checkHttpResponse: 200 含特征视为存活", () => {
  const r = checkHttpResponse(200, "<html>GitHub</html>", null, gh);
  assert.equal(r.ok, true);
  assert.equal(r.err, "");
});

test("checkHttpResponse: 200 缺 mustContain 判死", () => {
  const r = checkHttpResponse(200, "<html>nothing</html>", null, gh);
  assert.equal(r.ok, false);
  assert.ok(r.err.includes("missing:github"));
});

test("checkHttpResponse: 302 含特征视为存活", () => {
  const r = checkHttpResponse(302, "GitHub", null, gh);
  assert.equal(r.ok, true);
});

// 🔴 2026-10-11 行为反转（原来是「4xx 视为服务存在」）。
// 线上实测：`20.205.243.161` 对 github.com 的 `/`、`/login` 全回 **400**，
// 而响应体是 **GitHub 自己的错误页**（`<title>Bad request &middot; GitHub</title>`）——
// 于是旧判据 `mustContain:["github"]` 也命中，把它当成「服务存在」，排到第 1 名写进 hosts。
// 用户拿到 400，且**不会 fallback 到备选**（400 是合法 HTTP 响应，不是连接失败）。
// 现在：根路径只接受 2xx/3xx；响应体含 "bad request" 也直接拒。
test("checkHttpResponse: github.com 的 4xx 判死（假活 IP 的关键拦截点）", () => {
  const body400 = '<html><head><title>Bad request &middot; GitHub</title></head></html>';
  const r400 = checkHttpResponse(400, body400, null, gh);
  assert.equal(r400.ok, false);
  assert.ok(r400.err.includes("bad request") || r400.err.includes("status:400"));

  // 403 / 404 同理：体里含 GitHub 特征，但状态码不在白名单 -> 判死
  assert.equal(checkHttpResponse(404, "GitHub - 404", null, gh).ok, false);
  assert.equal(checkHttpResponse(403, "GitHub - forbidden", null, gh).ok, false);
});

// 反向保护：objects 的根路径本来就是 404（实测 Varnish 返回纯 "404 Not Found"，体里没有 github），
// 所以它的 4xx 必须继续放行，否则会把正常节点全判死。
test("checkHttpResponse: objects 的 4xx 仍放行（根路径本来就是 404）", () => {
  const objects = DOMAIN_SIG["objects.githubusercontent.com"];
  assert.equal(checkHttpResponse(404, "404 Not Found", null, objects).ok, true);
  assert.equal(checkHttpResponse(200, "<html>GitHub</html>", null, objects).ok, true);
});

test("checkHttpResponse: 5xx 判死", () => {
  const r = checkHttpResponse(500, "internal error", null, codeload);
  assert.equal(r.ok, false);
  assert.ok(r.err.includes("status:500"));
});

test("checkHttpResponse: Fastly unknown domain 判死（P0）", () => {
  const body = "<title>Fastly error: unknown domain github.com</title>";
  const r = checkHttpResponse(500, body, null, codeload);
  assert.equal(r.ok, false);
  assert.ok(r.err.includes("unknown domain") || r.err.includes("Fastly error"));
});

test("checkHttpResponse: codeload 坏节点 302 跳 github.com 主站判死", () => {
  const r = checkHttpResponse(302, "", "https://github.com/", codeload);
  assert.equal(r.ok, false);
  assert.ok(r.err.startsWith("redirect:"));
});

test("checkHttpResponse: codeload 正常 302 跳到 objects 放行", () => {
  const r = checkHttpResponse(302, "", "https://objects.githubusercontent.com/xxx", codeload);
  assert.equal(r.ok, true);
});

test("checkHttpResponse: 大小写不敏感", () => {
  const r = checkHttpResponse(503, "UNKNOWN DOMAIN", null, gh);
  assert.equal(r.ok, false);
});

test("checkHttpResponse: 未知状态码判死", () => {
  const r = checkHttpResponse(418, "teapot", null, codeload);
  assert.equal(r.ok, false);
  assert.ok(r.err.includes("status:418"));
});

test("gist 根路径 301 跳到 gist.github.com 放行", () => {
  const gist = DOMAIN_SIG["gist.githubusercontent.com"];
  const r = checkHttpResponse(301, "", "https://gist.github.com/", gist);
  assert.equal(r.ok, true);
});

test("jsdelivr 真实 CDN 路径 200 放行", () => {
  const js = DOMAIN_SIG["cdn.jsdelivr.net"];
  const r = checkHttpResponse(200, "The Linux kernel source tree", null, js);
  assert.equal(r.ok, true);
});

test("未知域名默认指纹：3xx 跳转不拦截", () => {
  const fallback = { path: "/", mustContain: [], allow: [200, 204, 301, 302, 303, 304, 307, 308, 400, 401, 403, 404], reject: ["unknown domain", "Fastly error"], redirectHosts: [] };
  const r = checkHttpResponse(301, "", "https://www.jsdelivr.com/", fallback);
  assert.equal(r.ok, true);
});

test("DOMAIN_SIG 覆盖全部默认目标域名及兜底 CDN", () => {
  for (const d of ["github.com", "codeload.github.com", "objects.githubusercontent.com", "raw.githubusercontent.com", "gist.githubusercontent.com", "avatars.githubusercontent.com", "cdn.jsdelivr.net"]) {
    assert.ok(DOMAIN_SIG[d], `缺少 ${d} 的指纹`);
    assert.ok(DOMAIN_SIG[d].allow.length > 0);
    assert.ok(DOMAIN_SIG[d].reject.length > 0);
  }
});

// ============================================================================
// 2026-10-11 新增：区分「IP 不可用」与「本机 TLS 指纹被阻断」
// 实测：同 IP、同 SNI、同时间，openssl s_client 20/20 成功、node 5/20、curl 3/20，
//       而浏览器（Edge）能正常打开同一 URL。ghprobe 自己是 Node，
//       把这类失败当成「IP 不可用」会误伤浏览器其实能用的域名。
// ============================================================================
test("looksLikeTlsBlocked: TCP 连上但 TLS 被 reset -> 判定为指纹阻断", () => {
  assert.equal(looksLikeTlsBlocked({ ok: false, stage: "tls", err: "ECONNRESET" }), true);
  assert.equal(looksLikeTlsBlocked({ ok: false, stage: "tls", err: "timeout" }), true);
  assert.equal(looksLikeTlsBlocked({ ok: false, stage: "tls", err: "socket hang up" }), true);
});

test("looksLikeTlsBlocked: TCP 阶段就失败 / 成功 / 证书错误 -> 不算指纹阻断", () => {
  // TCP 都没连上 = IP 真的不可用
  assert.equal(looksLikeTlsBlocked({ ok: false, stage: "tcp", err: "timeout" }), false);
  assert.equal(looksLikeTlsBlocked({ ok: false, stage: "tcp", err: "ECONNREFUSED" }), false);
  // 成功的不算
  assert.equal(looksLikeTlsBlocked({ ok: true }), false);
  // 证书不匹配属于「IP 服务了别的域名」，不是指纹问题
  assert.equal(looksLikeTlsBlocked({ ok: false, stage: "tls", err: "ERR_TLS_CERT_ALTNAME_INVALID" }), false);
});
