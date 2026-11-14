// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 zmw
// v0.1.11 调度重排：监督任务 1min -> 5min、daemon 健康态 45s -> 90s（均可配、热生效）。
import "./helpers.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { loadConfig } from "../src/config.js";
import { runDaemon, nextIntervalMs } from "../src/daemon.js";

test("loadConfig: 调度默认值重排(监督 5min / daemon 90s / 15s / 120s)", () => {
  const cfg = loadConfig();
  assert.equal(cfg.schedule.healthMin, 5);
  assert.equal(cfg.schedule.daemonHealthyMs, 90_000);
  assert.equal(cfg.schedule.daemonFastMs, 15_000);
  assert.equal(cfg.schedule.daemonOfflineMs, 120_000);
  assert.equal(cfg.schedule.absentCooldownHours, 1);
});

test("runDaemon: 间隔从 cfg.schedule 接线(健康态 sleep 用 daemonHealthyMs)", async () => {
  const sleeps = [];
  const cfg = { schedule: { healthMin: 5, daemonHealthyMs: 90_000, daemonFastMs: 15_000, daemonOfflineMs: 120_000 } };
  await runDaemon(cfg, () => {}, {
    jitter: 0,
    maxCycles: 2, // 第 2 轮才返回,保证第 1 轮后发生一次 sleep
    cycle: async () => ({ action: "none", reason: "全部健康" }),
    sleep: async (ms) => { sleeps.push(ms); },
  });
  assert.deepEqual(sleeps, [90_000], `健康态应睡 daemonHealthyMs: ${JSON.stringify(sleeps)}`);
});

test("runDaemon: 异常轮用 daemonFastMs,断网轮用 daemonOfflineMs(经 nextIntervalMs)", () => {
  const iv = { healthy: 90_000, fast: 15_000, offline: 120_000 };
  assert.equal(nextIntervalMs({ action: "none" }, iv), 90_000);
  assert.equal(nextIntervalMs({ action: "full", reason: "需重排" }, iv), 15_000);
  assert.equal(nextIntervalMs({ offline: true }, iv), 120_000);
});

test("nextIntervalMs: 不传 intervals 时退回函数级默认(45s/15s/120s),调用方兼容", () => {
  assert.equal(nextIntervalMs({ action: "none" }), 45_000);
  assert.equal(nextIntervalMs({ action: "full" }), 15_000);
  assert.equal(nextIntervalMs({ offline: true }), 120_000);
});

test("runDaemon: deps.intervals 显式注入优先于 cfg(单测/自定义不变)", async () => {
  const sleeps = [];
  await runDaemon({ schedule: { daemonHealthyMs: 90_000 } }, () => {}, {
    jitter: 0,
    maxCycles: 2,
    cycle: async () => ({ action: "none" }),
    sleep: async (ms) => { sleeps.push(ms); },
    intervals: { healthy: 7000, fast: 2000, offline: 60_000 },
  });
  assert.deepEqual(sleeps, [7000]);
});
