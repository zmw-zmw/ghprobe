// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 zmw
// 本地网络检查单测：全部用本机回环做「可控目标」，不依赖真实外网（避免 CI / 断网时抖动）
import "./helpers.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import { hasInterface, canReach, hasLocalNetwork } from "../src/net.js";

// 起一个临时回环服务，返回 { port, close }
function listen() {
  return new Promise((resolve) => {
    const srv = net.createServer(() => {});
    srv.listen(0, "127.0.0.1", () => {
      resolve({ port: srv.address().port, close: () => new Promise((r) => srv.close(r)) });
    });
  });
}

// 拿一个「一定没人监听」的端口：先占住再关掉，端口随即空出
async function deadPort() {
  const s = await listen();
  const p = s.port;
  await s.close();
  return p;
}

test("hasInterface: 返回布尔值（有非回环 IPv4 网卡时为 true）", () => {
  const v = hasInterface();
  assert.equal(typeof v, "boolean");
  // 本机（开发/CI）必然有网卡，但即使没有也只断言类型，不制造环境依赖
});

test("canReach: 连得上回环监听端口 -> true", async () => {
  const s = await listen();
  try {
    assert.equal(await canReach("127.0.0.1", s.port, 1000), true);
  } finally { await s.close(); }
});

test("canReach: 端口无人监听（ECONNREFUSED）-> false", async () => {
  const p = await deadPort();
  assert.equal(await canReach("127.0.0.1", p, 1000), false);
});

test("canReach: 目标黑洞（超时）-> false，且不抛异常", async () => {
  // 192.0.2.0/24 是 RFC 5737 保留的测试网段，正常不会被路由 -> 只会超时
  assert.equal(await canReach("192.0.2.1", 9, 400), false);
});

test("hasLocalNetwork: networkCheck.enabled=false 时短路返回 true（不探测）", async () => {
  const p = await deadPort(); // 就算指向死端口也必须 true：说明压根没去探
  assert.equal(await hasLocalNetwork({ networkCheck: { enabled: false, probe: { host: "127.0.0.1", port: p } } }), true);
});

test("hasLocalNetwork: 基准目标可达 -> true", async () => {
  const s = await listen();
  try {
    const cfg = { networkCheck: { enabled: true, probe: { host: "127.0.0.1", port: s.port, timeoutMs: 1000 } } };
    assert.equal(await hasLocalNetwork(cfg), true);
  } finally { await s.close(); }
});

test("hasLocalNetwork: 基准目标不可达 -> false", async () => {
  const p = await deadPort();
  const cfg = { networkCheck: { enabled: true, probe: { host: "127.0.0.1", port: p, timeoutMs: 500 } } };
  assert.equal(await hasLocalNetwork(cfg), false);
});

test("hasLocalNetwork: 缺省配置（无 networkCheck 段）也能给出布尔判定", async () => {
  // 默认探测 223.5.5.5:443，结果取决于本机网络；这里只要求「不抛 + 是布尔」
  assert.equal(typeof (await hasLocalNetwork({})), "boolean");
});
