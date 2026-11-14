// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 zmw
// v0.1.12 反制裁两件套：轻探活（健康态只探主条目，备选按需）+ 间隔抖动（打破机器周期特征）。
import "./helpers.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runHealth } from "../src/health.js";
import { runDaemon } from "../src/daemon.js";
import { buildHealthBlock, parseBlock } from "../src/health.js";

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "ghprobe-v12-"));
}

// stub probeIp:按 (domain,ip) 决定生死,并记录全部调用
function stubProbe(calls, aliveSet) {
  return async (domain, ip) => {
    calls.push(`${domain}|${ip}`);
    const ok = aliveSet.has(`${domain}|${ip}`);
    return ok
      ? { domain, ip, ok: true, tcpMs: 10, tlsMs: 20, ttfb: 30, score: 20, err: "" }
      : { domain, ip, ok: false, stage: "tcp", err: "timeout" };
  };
}

const baseCfg = (over = {}) => ({
  domains: ["github.com", "api.github.com"], fallbacks: {}, doh: [],
  timeouts: { dohMs: 100, tcpMs: 120, tlsMs: 200, httpMs: 200 },
  probe: { concurrency: 4, schannelRetry: false, stableSamples: 1 },
  hosts: { maxEntriesPerDomain: 2 },
  schedule: { lightProbe: true },
  proxy: { enabled: false },
  ...over,
});

test("轻探活: 健康态只探主条目,备选零连接", async () => {
  const dir = tmpDir();
  const hostsPath = path.join(dir, "hosts");
  fs.writeFileSync(hostsPath, buildHealthBlock(
    new Map([["github.com", "1.1.1.1"], ["api.github.com", "2.2.2.2"]]),
    new Map(), new Map([["github.com", ["3.3.3.3"], ], ["api.github.com", ["4.4.4.4"]]]),
  ), "utf8");
  const cfg = baseCfg();
  const calls = [];
  const r = await runHealth(cfg, () => {}, false, hostsPath, new Map(), {}, {
    probeIp: stubProbe(calls, new Set(["github.com|1.1.1.1", "api.github.com|2.2.2.2"])),
    detectProxy: async () => ({ found: false, alive: false }),
  });
  assert.equal(r.action, "none", `全健康应静默: ${JSON.stringify(r)}`);
  assert.ok(!calls.includes("github.com|3.3.3.3"), "备选不该被探测");
  assert.equal(calls.filter((c) => c.startsWith("github.com|")).length, 1, "每域名只探主条目一次");
});

test("轻探活: 主挂 -> 当轮补测备选,备选活则 promote(不重排)", async () => {
  const dir = tmpDir();
  const hostsPath = path.join(dir, "hosts");
  fs.writeFileSync(hostsPath, buildHealthBlock(
    new Map([["github.com", "1.1.1.1"]]),
    new Map(), new Map([["github.com", ["3.3.3.3"]]]),
  ), "utf8");
  const cfg = baseCfg();
  const calls = [];
  const r = await runHealth(cfg, () => {}, false, hostsPath, new Map(), {}, {
    probeIp: stubProbe(calls, new Set(["github.com|3.3.3.3"])), // 主死备活
    detectProxy: async () => ({ found: false, alive: false }),
    runProbe: async () => ({ ranked: new Map(), extra: new Map(), raw: [] }),
  });
  assert.equal(r.action, "full");
  assert.ok(/提上备选/.test(r.reason), `应提升备选: ${r.reason}`);
  assert.ok(calls.includes("github.com|1.1.1.1"), "先探主");
  assert.ok(calls.includes("github.com|3.3.3.3"), "主死后当轮补测备选");
  assert.equal(calls.length, 2, "总连接数 = 主1 + 补测备选1");
});

test("轻探活: 主备全死 -> 补测后照旧重排,与旧语义一致", async () => {
  const dir = tmpDir();
  const hostsPath = path.join(dir, "hosts");
  fs.writeFileSync(hostsPath, buildHealthBlock(new Map([["github.com", "1.1.1.1"]]), new Map(), new Map([["github.com", ["3.3.3.3"]]])), "utf8");
  const cfg = baseCfg();
  const r = await runHealth(cfg, () => {}, false, hostsPath, new Map(), {}, {
    probeIp: stubProbe([], new Set()), // 全死
    detectProxy: async () => ({ found: false, alive: false }),
    runProbe: async () => ({ ranked: new Map([["github.com", [{ domain: "github.com", ip: "5.5.5.5", ok: true, score: 10 }]]]), extra: new Map(), raw: [] }),
  });
  assert.equal(r.action, "full", `主备全死应重排: ${JSON.stringify(r)}`);
  assert.ok(r.block.includes("5.5.5.5 github.com"), "重排结果应含新 IP");
});

test("lightProbe: false 退回旧行为(主备都探)", async () => {
  const dir = tmpDir();
  const hostsPath = path.join(dir, "hosts");
  fs.writeFileSync(hostsPath, buildHealthBlock(
    new Map([["github.com", "1.1.1.1"]]),
    new Map(), new Map([["github.com", ["3.3.3.3"]]]),
  ), "utf8");
  const cfg = baseCfg({ schedule: { lightProbe: false } });
  const calls = [];
  await runHealth(cfg, () => {}, false, hostsPath, new Map(), {}, {
    probeIp: stubProbe(calls, new Set(["github.com|1.1.1.1", "github.com|3.3.3.3"])),
    detectProxy: async () => ({ found: false, alive: false }),
    runProbe: async () => ({ ranked: new Map(), extra: new Map(), raw: [] }),
  });
  assert.deepEqual(calls.sort(), ["github.com|1.1.1.1", "github.com|3.3.3.3"], "关闭轻探活 = 主备都探");
});

test("抖动: sleep 落在 [0.85x, 1.15x] 区间内(默认 ±15%)", async () => {
  const sleeps = [];
  await runDaemon({ schedule: { daemonHealthyMs: 90_000 } }, () => {}, {
    maxCycles: 8,
    cycle: async () => ({ action: "none" }),
    sleep: async (ms) => { sleeps.push(ms); },
  });
  assert.equal(sleeps.length, 7, "8 轮之间 7 次 sleep");
  for (const ms of sleeps) {
    assert.ok(ms >= 90_000 * 0.85 - 1 && ms <= 90_000 * 1.15 + 1, `抖动应落区间: ${ms}`);
  }
  // 抖动是真随机的:7 个值里至少有 3 个不同值(概率上几乎必然)
  assert.ok(new Set(sleeps).size >= 3, `抖动应有随机性: ${sleeps}`);
});

test("抖动: jitter=0 精确间隔(测试/强迫症可用)", async () => {
  const sleeps = [];
  await runDaemon({ schedule: { daemonHealthyMs: 90_000 } }, () => {}, {
    jitter: 0,
    maxCycles: 2,
    cycle: async () => ({ action: "none" }),
    sleep: async (ms) => { sleeps.push(ms); },
  });
  assert.deepEqual(sleeps, [90_000]);
});
