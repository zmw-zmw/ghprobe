// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 zmw
// v0.1.13 反运营商三件套：低调模式一键化 / 全灭指数退避 / 探测 UA 中性化。
import "./helpers.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { runDaemon, nextIntervalMs } from "../src/daemon.js";
import { NEUTRAL_UA } from "../src/prober.js";
import { applyLowkey, removeLowkey, isLowkey, readUserConfig, writeUserConfig } from "../src/lowkey.js";
import { loadConfig, userConfigPath } from "../src/config.js";

// ---------- UA 中性化 ----------

test("UA 中性化: 默认 UA 不含 ghprobe 字样,config 默认键与其一致", () => {
  assert.ok(!/ghprobe/i.test(NEUTRAL_UA), `UA 不应自报家门: ${NEUTRAL_UA}`);
  const cfg = loadConfig();
  assert.equal(cfg.probe.userAgent, NEUTRAL_UA, "默认配置应带中性 UA 键");
});

// ---------- 全灭指数退避 ----------

const IV = { healthy: 45_000, fast: 15_000, offline: 120_000, stuckBackoffMaxMs: 1_800_000 };

test("全灭退避: 首轮仍 fast,连续全灭指数拉开,健康/断网不受 streak 影响", () => {
  const stuck = { action: "full", stuck: ["github.com"] };
  assert.equal(nextIntervalMs(stuck, IV, 0), 15_000, "streak 未计入时=fast");
  assert.equal(nextIntervalMs(stuck, IV, 1), 15_000, "连续第 1 轮=15s(抖动确认)");
  assert.equal(nextIntervalMs(stuck, IV, 2), 30_000);
  assert.equal(nextIntervalMs(stuck, IV, 3), 60_000);
  assert.equal(nextIntervalMs(stuck, IV, 9), Math.min(15_000 * 2 ** 8, 1_800_000), "30min 封顶");
  assert.equal(nextIntervalMs({ action: "full", stuck: [] }, IV, 0), 15_000, "非全灭异常照旧 fast");
  assert.equal(nextIntervalMs({ action: "none", stuck: [] }, IV, 5), 45_000, "健康无视 streak");
  assert.equal(nextIntervalMs(null, IV, 0), 120_000, "断网档不变");
});

test("全灭退避: runDaemon 连续全灭 sleep 指数拉开,非全灭轮不累积", async () => {
  const sleeps = [];
  const results = [
    { action: "full", stuck: ["github.com"] },                   // streak 1
    { action: "full", stuck: ["github.com"] },                   // streak 2
    { action: "full", stuck: ["github.com", "api.github.com"] }, // streak 3
    { action: "full", stuck: ["github.com"] },                   // streak 4（凑轮数,最后一轮不产生 sleep）
  ];
  let i = 0;
  await runDaemon({}, () => {}, {
    maxCycles: results.length, jitter: 0,
    intervals: IV,
    cycle: async () => results[i++],
    sleep: async (ms) => sleeps.push(ms),
  });
  assert.deepEqual(sleeps, [15_000, 30_000, 60_000], `连续全灭应指数拉开: ${sleeps}`);
});

test("全灭退避: 中间成功一轮 streak 清零,再次全灭重新从 fast 起步", async () => {
  const sleeps = [];
  // sleep 只发生在轮与轮之间（最后一轮返回前不 sleep），所以要凑第 4 轮才能观察到第 3 次间隔
  const results = [
    { action: "full", stuck: ["github.com"] },
    { action: "none", stuck: [] },
    { action: "full", stuck: ["github.com"] },
    { action: "none", stuck: [] },
  ];
  let i = 0;
  await runDaemon({}, () => {}, {
    maxCycles: results.length, jitter: 0,
    intervals: IV,
    cycle: async () => results[i++],
    sleep: async (ms) => sleeps.push(ms),
  });
  assert.deepEqual(sleeps, [15_000, 45_000, 15_000], `成功清零后应重新从 fast 起步: ${sleeps}`);
});

// ---------- 低调模式 ----------

test("lowkey: on 覆盖预设键,用户自有覆盖与非相关键保留", () => {
  const user = { probe: { schannelRetry: false, userAgent: "x" }, schedule: { healthMin: 3 }, custom: 1 };
  const on = applyLowkey(user);
  assert.equal(isLowkey(on), true);
  assert.equal(on.probe.maxCandidates, 4);
  assert.equal(on.probe.concurrency, 4);
  assert.equal(on.probe.maxPoolIps, 12);
  assert.equal(on.probe.schannelRetry, false, "用户自有子键保留");
  assert.equal(on.schedule.daemonHealthyMs, 120_000);
  assert.equal(on.schedule.healthMin, 3, "非预设子键保留");
  assert.equal(on.custom, 1);
  assert.ok(Array.isArray(on.doh) && on.doh.length === 5, "5 条无 SNI DoH");
  assert.ok(on.doh.every((e) => !("sni" in e)), "全部无 sni 字段");
  assert.ok(on.doh.every((e) => e.host), "端点信息完整");
  assert.deepEqual(on.dohUdp.servers, ["114.114.114.114", "119.29.29.29"]);
  assert.equal(on.proxy.idleProbeMin, 10);
});

test("lowkey: off 删除预设键、空壳父键清理、标记移除,其它内容原样", () => {
  const off = removeLowkey(applyLowkey({ probe: { schannelRetry: false }, schedule: { healthMin: 3 } }));
  assert.equal(isLowkey(off), false);
  assert.equal(off.doh, undefined, "doh 整键删除回落默认");
  assert.equal(off.dohUdp, undefined, "dohUdp 整键删除回落默认");
  assert.equal(off.probe.maxCandidates, undefined, "预设子键删除");
  assert.equal(off.probe.schannelRetry, false, "用户自有子键保留");
  assert.equal(off.schedule.healthMin, 3, "非预设子键保留");
  assert.equal(off.schedule.daemonHealthyMs, undefined);
  assert.equal(off.proxy, undefined, "proxy 只被预设触碰时整键清掉");
  assert.ok(!("lowkey" in off), "标记删除");
  assert.equal(removeLowkey(null) && typeof removeLowkey(null), "object", "空输入不抛");
});

test("lowkey: 用户配置文件往返(读/写/状态)", () => {
  const original = readUserConfig();
  try {
    writeUserConfig(applyLowkey(original || {}));
    assert.equal(isLowkey(readUserConfig()), true, "on 落盘");
    writeUserConfig(removeLowkey(readUserConfig()));
    const after = readUserConfig();
    assert.equal(isLowkey(after), false, "off 落盘");
    assert.equal(after.doh, undefined, "off 后 doh 回落默认");
  } finally {
    // 还原测试前的用户配置（helpers.js 已把 LOCALAPPDATA 指到临时目录，通常本来就不存在）
    if (original) { writeUserConfig(original); } else { try { fs.rmSync(userConfigPath(), { force: true }); } catch { /* 忽略 */ } }
  }
});
