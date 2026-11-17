// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 zmw
// v0.1.13 末批：健康期拉长（探活优化）+ 空闲窗口主动重排（在用户没访问时候切换）。
import "./helpers.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { nextIntervalMs, runDaemon, idleReRankDue } from "../src/daemon.js";
import { runHealth, buildHealthBlock } from "../src/health.js";

test("健康期拉长: streak≥3 起 +25%/轮,上限 2×;异常立即打回原形", () => {
  const healthy = { action: "none", stuck: [] };
  const iv = { healthy: 90_000, fast: 15_000, offline: 120_000, stuckBackoffMaxMs: 300_000 };
  assert.equal(nextIntervalMs(healthy, iv, 0, 0), 90_000, "streak<3 不拉长");
  assert.equal(nextIntervalMs(healthy, iv, 0, 3), 90_000, "streak=3 起步不涨");
  assert.equal(nextIntervalMs(healthy, iv, 0, 4), 112_500, "+25%/轮");
  assert.equal(nextIntervalMs(healthy, iv, 0, 5), 135_000);
  assert.equal(nextIntervalMs(healthy, iv, 0, 20), 180_000, "2× 封顶");
  assert.equal(nextIntervalMs({ action: "full", stuck: [] }, iv, 0, 20), 15_000, "异常立即打回 fast");
});

test("空闲重排判定: 成本 0 + 到期才 due;忙/未到期/0 关闭都不 due", () => {
  const now = 1_000_000_000_000;
  const min = 30;
  assert.equal(idleReRankDue(0, 0, now, min), true, "从未重排过即到期");
  assert.equal(idleReRankDue(0, now - 31 * 60_000, now, min), true, "超 30min 到期");
  assert.equal(idleReRankDue(0, now - 10 * 60_000, now, min), false, "未到期");
  assert.equal(idleReRankDue(100, 0, now, min), false, "用户在访问(成本 100)");
  assert.equal(idleReRankDue(30, 0, now, min), false, "浏览器后台(成本 30)也不行");
  assert.equal(idleReRankDue(0, 0, now, 0), false, "0 = 关闭");
  assert.equal(idleReRankDue(0, 0, now, undefined), true, "未配置回落默认 30min");
});

test("空闲重排: runHealth 收到 idleReRank 时全量重排并返回 full", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ghprobe-v19-"));
  const hostsPath = path.join(dir, "hosts");
  fs.writeFileSync(hostsPath, buildHealthBlock(new Map([["github.com", "1.1.1.1"]]), new Map(), new Map()), "utf8");
  const logs = [];
  const r = await runHealth(
    { domains: ["github.com"], fallbacks: {}, doh: [], timeouts: { dohMs: 100, tcpMs: 120, tlsMs: 200, httpMs: 200 }, probe: { concurrency: 4 }, hosts: { maxEntriesPerDomain: 2 }, schedule: { lightProbe: true } },
    (m) => logs.push(m), false, hostsPath, new Map(), { idleReRank: true }, {
      probeIp: async (domain, ip) => ({ domain, ip, ok: true, ttfb: 100, err: "" }),
      detectProxy: async () => ({ found: false, alive: false }),
      runProbe: async () => ({ ranked: new Map([["github.com", [{ domain: "github.com", ip: "5.5.5.5", ok: true, ttfb: 80 }]]]), extra: new Map(), raw: [] }),
    });
  assert.ok(r.action === "full", `idleReRank 应触发全量重排: ${r.action} ${r.reason}`);
  assert.ok(logs.some((l) => l.includes("空闲窗口主动重排")), "应有空闲重排日志");
});

test("空闲重排: 未收到 idleReRank 时保持 none(不影响常规健康路径)", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ghprobe-v19b-"));
  const hostsPath = path.join(dir, "hosts");
  fs.writeFileSync(hostsPath, buildHealthBlock(new Map([["github.com", "1.1.1.1"]]), new Map(), new Map()), "utf8");
  const r = await runHealth(
    { domains: ["github.com"], fallbacks: {}, doh: [], timeouts: { dohMs: 100, tcpMs: 120, tlsMs: 200, httpMs: 200 }, probe: { concurrency: 4 }, hosts: { maxEntriesPerDomain: 2 }, schedule: { lightProbe: true } },
    () => {}, false, hostsPath, new Map(), {}, {
      probeIp: async (domain, ip) => ({ domain, ip, ok: true, ttfb: 100, err: "" }),
      detectProxy: async () => ({ found: false, alive: false }),
    });
  assert.equal(r.action, "none");
});
