// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 zmw
// 接口测试：serve HTTP API 全端点走一遍（探测用替身注入，不打真网络）
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { startServer } from "../src/server.js";

const cfg = {
  serve: { host: "127.0.0.1", port: 0 },
  domains: ["github.com"],
  doh: [], ipPools: {}, timeouts: {}, probe: {},
};

// 探测替身：mode 可切 ok / slow / throw
const fake = { calls: 0, mode: "ok" };
const run = async () => {
  fake.calls++;
  if (fake.mode === "slow") { await new Promise((r) => setTimeout(r, 300)); }
  if (fake.mode === "throw") { throw new Error("替身故障"); }
  return {
    ranked: new Map([["github.com", [{ ip: "20.205.243.166", tcpMs: 30, tlsMs: 80, ttfb: 120, score: 88 }]]]),
    extra: new Map([["cdn.jsdelivr.net", [{ ip: "104.16.0.1", tcpMs: 40, tlsMs: 90, ttfb: 130, score: 95 }]]]),
    raw: [],
    at: new Date().toISOString(),
  };
};

const server = await startServer(cfg, () => {}, run);
const base = `http://127.0.0.1:${server.address().port}`;
after(() => { server.close(); });

test("GET /api/status 探测前未就绪", async () => {
  const j = await (await fetch(`${base}/api/status`)).json();
  assert.equal(j.ready, false);
  assert.equal(j.probing, false);
});

test("GET /api/hosts 探测前给占位提示", async () => {
  const t = await (await fetch(`${base}/api/hosts`)).text();
  assert.ok(t.includes("尚无结果"));
});

test("GET /api/config 返回生效配置", async () => {
  const j = await (await fetch(`${base}/api/config`)).json();
  assert.deepEqual(j.serve, cfg.serve);
});

test("POST /api/probe 触发探测并返回摘要", async () => {
  const r = await fetch(`${base}/api/probe`, { method: "POST" });
  assert.equal(r.status, 200);
  const j = await r.json();
  assert.equal(fake.calls, 1);
  assert.equal(j.domains[0].domain, "github.com");
  assert.equal(j.domains[0].alive[0].ip, "20.205.243.166");
});

test("GET /api/status 探测后就绪且含结果", async () => {
  const j = await (await fetch(`${base}/api/status`)).json();
  assert.equal(j.ready, true);
  assert.ok(j.at);
  assert.equal(j.domains[0].alive[0].ip, "20.205.243.166");
});

test("GET /api/hosts 探测后含块标记与条目", async () => {
  const t = await (await fetch(`${base}/api/hosts`)).text();
  assert.ok(t.includes("# === ghprobe begin ==="));
  assert.ok(t.includes("20.205.243.166 github.com"));
  assert.ok(t.includes("104.16.0.1 cdn.jsdelivr.net"));
});

test("未知路径返回 404", async () => {
  const r = await fetch(`${base}/api/nope`);
  assert.equal(r.status, 404);
  assert.equal((await r.json()).error, "not found");
});

test("并发探测：第二个请求被拒", async () => {
  fake.mode = "slow";
  const p1 = fetch(`${base}/api/probe`, { method: "POST" });
  await new Promise((r) => setTimeout(r, 50));
  const r2 = await fetch(`${base}/api/probe`, { method: "POST" });
  assert.equal(r2.status, 500);
  assert.ok((await r2.json()).error.includes("已有探测在跑"));
  assert.equal((await p1).status, 200);
  fake.mode = "ok";
});

test("POST /api/probe 探测报错返回 500", async () => {
  fake.mode = "throw";
  const r = await fetch(`${base}/api/probe`, { method: "POST" });
  assert.equal(r.status, 500);
  assert.ok((await r.json()).error.includes("替身故障"));
  fake.mode = "ok";
});
