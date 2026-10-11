// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 zmw
// prober 应用层终审单测：不连真实网络，只校验判定函数
import { test } from "node:test";
import assert from "node:assert/strict";
import { DOMAIN_SIG, checkHttpResponse } from "../src/prober.js";

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

test("checkHttpResponse: 4xx 视为服务存在（路径/鉴权问题）", () => {
  // github.com 根路径 4xx 也含 GitHub 特征
  assert.equal(checkHttpResponse(404, "GitHub - 404", null, gh).ok, true);
  assert.equal(checkHttpResponse(403, "GitHub - forbidden", null, gh).ok, true);
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
