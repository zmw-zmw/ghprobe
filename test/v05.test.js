// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 zmw
// 0.5.0 daemon 单测：心跳 / 单实例决策 / 自适应间隔 / 主循环（全注入，不打网络不真睡）
import "./helpers.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import {
  heartbeatFresh, processAlive, daemonRunning, nextIntervalMs, runDaemon, heartbeatPath, writeHeartbeat, readHeartbeat,
} from "../src/daemon.js";

test("heartbeatFresh：新鲜/陈旧/损坏", () => {
  const now = Date.now();
  assert.equal(heartbeatFresh({ at: new Date(now - 10_000).toISOString(), pid: 1 }, now), true);
  assert.equal(heartbeatFresh({ at: new Date(now - 200_000).toISOString(), pid: 1 }, now), false);
  assert.equal(heartbeatFresh(null, now), false);
  assert.equal(heartbeatFresh({ pid: 1 }, now), false);
  assert.equal(heartbeatFresh({ at: "not-a-date", pid: 1 }, now), false);
});

test("processAlive：非法 pid false；不存在 false；EPERM 视为存在", () => {
  assert.equal(processAlive(0), false);
  assert.equal(processAlive(-1), false);
  assert.equal(processAlive(undefined), false);
  assert.equal(processAlive(4_000_000_000), false, "不存在的 pid（ESRCH）");
});

test("daemonRunning：新鲜+活+别人的 pid 才算在跑", () => {
  const now = Date.now();
  assert.equal(daemonRunning({ at: new Date(now - 5_000).toISOString(), pid: process.pid }, now), false, "自己不算别的实例");
  assert.equal(daemonRunning({ at: new Date(now - 200_000).toISOString(), pid: 4 }, now), false, "陈旧心跳");
  assert.equal(daemonRunning(null, now), false);
});

test("nextIntervalMs：断网 120s / 异常或 stuck 15s / 健康 45s", () => {
  assert.equal(nextIntervalMs({ offline: true }), 120_000);
  assert.equal(nextIntervalMs(null), 120_000);
  assert.equal(nextIntervalMs({ action: "full", stuck: [] }), 15_000);
  assert.equal(nextIntervalMs({ action: "error" }), 15_000);
  assert.equal(nextIntervalMs({ action: "none", stuck: ["github.com"] }), 15_000);
  assert.equal(nextIntervalMs({ action: "none", stuck: [] }), 45_000);
  assert.equal(nextIntervalMs({ action: "none", stuck: [] }, { healthy: 1000 }), 1000);
});

test("runDaemon：maxCycles + 心跳逐轮刷新 + 间隔序列（健康/异常/健康）", async () => {
  const sleeps = [];
  let cycles = 0;
  const r = await runDaemon({}, () => {}, {
    maxCycles: 3,
    jitter: 0,
    sleep: async (ms) => { sleeps.push(ms); },
    cycle: async () => {
      cycles += 1;
      if (cycles === 2) { throw new Error("注入故障"); }
      return { action: "none", reason: "全部健康", stuck: [] };
    },
  });
  assert.deepEqual(r, { started: true, cycles: 3 });
  assert.deepEqual(sleeps, [90_000, 15_000]); // 健康轮 -> 90s（0.1.11 起）；异常轮 -> 15s；末轮不再睡
  // 心跳文件真实落盘（helpers 已把 LOCALAPPDATA 指到临时目录）
  const hb = readHeartbeat();
  assert.ok(hb && hb.pid === process.pid && heartbeatFresh(hb));
});

test("runDaemon：offline 轮走 120s", async () => {
  const sleeps = [];
  await runDaemon({}, () => {}, {
    jitter: 0,
    maxCycles: 2,
    sleep: async (ms) => { sleeps.push(ms); },
    cycle: async () => ({ action: "skip", reason: "本地无网络连接", offline: true }),
  });
  assert.deepEqual(sleeps, [120_000]);
});

test("runDaemon：让位给更年轻的实例（真实心跳文件 + 活 pid）", { skip: !processAlive(4) }, async () => {
  // pid 4（Windows System）恒存在：伪造它的「新鲜心跳」模拟另一个 daemon
  writeHeartbeat(); // 先确保目录存在
  fs.writeFileSync(heartbeatPath(), JSON.stringify({ at: new Date().toISOString(), pid: 4 }));
  const r = await runDaemon({}, () => {}, { jitter: 0, maxCycles: 1, cycle: async () => ({ action: "none", stuck: [] }) });
  assert.equal(r.started, false);
  assert.ok(r.reason.includes("已有 daemon"));
});
