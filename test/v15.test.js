// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 zmw
// v0.1.13「乱掉」三件套：泊松节奏（无记忆间隔）/ DoH 端点随机抽样 / 候选顺序洗牌。
// 目标不是更低调，而是让运营商画像算法拿到的时序在数学上提不出特征。
import "./helpers.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { runDaemon, sampleInterval, nextIntervalMs } from "../src/daemon.js";
import { shuffle, pickEndpoints } from "../src/doh.js";

// ---------- 泊松节奏 ----------

test("sampleInterval: poisson 样本落在钳位区间,均值近似 base(大样本)", () => {
  const base = 90_000;
  const samples = Array.from({ length: 1000 }, () => sampleInterval(base, "poisson"));
  for (const w of samples) {
    assert.ok(w >= base * 0.25 - 1 && w <= base * 2 + 1, `钳位区间外: ${w}`);
  }
  const mean = samples.reduce((a, b) => a + b, 0) / samples.length;
  // 上钳位 2x 截掉 13.5% 上尾 -> 均值系统性略低于 base(~0.89x),容差给到覆盖
  assert.ok(mean > base * 0.75 && mean < base * 1.05, `均值应近似 base: ${mean}`);
  // 连续分布几乎无重复值 —— 但钳位两端会各撞出一个常数档(0.25x/2x)
  assert.ok(new Set(samples).size > 250, `应充分随机: ${new Set(samples).size} 个不同值`);
});

test("sampleInterval: jitter=0 / fixed 恒精确,uniform 落 ±jitter 区间", () => {
  assert.equal(sampleInterval(90_000, "poisson", 0), 90_000, "jitter:0 是精确间隔逃生门");
  assert.equal(sampleInterval(90_000, "fixed"), 90_000);
  for (let i = 0; i < 50; i++) {
    const w = sampleInterval(90_000, "uniform", 0.15);
    assert.ok(w >= 90_000 * 0.85 - 1 && w <= 90_000 * 1.15 + 1, `uniform 越界: ${w}`);
  }
});

test("runDaemon: 默认 poisson——等待无固定周期且不被钳位区间约束死", async () => {
  const sleeps = [];
  await runDaemon({ schedule: { daemonHealthyMs: 90_000 } }, () => {}, {
    maxCycles: 31,
    cycle: async () => ({ action: "none", stuck: [] }),
    sleep: async (ms) => { sleeps.push(ms); },
  });
  assert.equal(sleeps.length, 30);
  for (const w of sleeps) {
    assert.ok(w >= 90_000 * 0.25 - 1 && w <= 90_000 * 2 + 1, `泊松钳位区间外: ${w}`);
  }
  const mean = sleeps.reduce((a, b) => a + b, 0) / sleeps.length;
  assert.ok(mean > 90_000 * 0.4 && mean < 90_000 * 2, `30 样本均值应靠近 base: ${mean}`);
  assert.ok(new Set(sleeps).size >= 10, `应充分随机: ${new Set(sleeps).size} 个不同值`);
});

test("runDaemon: 退避间隔也泊松化(均值=退避值,钳位不越过退避上限)", async () => {
  const sleeps = [];
  const stuck = { action: "full", stuck: ["github.com"] };
  // 退避上限钉 60s:streak>=3 后 base 恒为 60s,泊松样本应全部落在 [0.25x, 3x] * 60000
  await runDaemon({}, () => {}, {
    maxCycles: 21,
    intervals: { healthy: 45_000, fast: 15_000, offline: 120_000, stuckBackoffMaxMs: 60_000 },
    cycle: async () => stuck,
    sleep: async (ms) => { sleeps.push(ms); },
  });
  for (const w of sleeps.slice(5)) {
    assert.ok(w >= 60_000 * 0.25 - 1 && w <= 60_000 * 3 + 1, `退避泊松越界: ${w}`);
  }
});

test("nextIntervalMs 与 sampleInterval 组合:全灭深退避仍受 stuckBackoffMaxMs 约束", () => {
  const iv = { healthy: 45_000, fast: 15_000, offline: 120_000, stuckBackoffMaxMs: 60_000 };
  const stuck = { action: "full", stuck: ["a"] };
  const base = nextIntervalMs(stuck, iv, 20); // 深退避 -> 60s 封顶
  assert.equal(base, 60_000);
  for (let i = 0; i < 30; i++) {
    const w = sampleInterval(base, "poisson");
    assert.ok(w <= 60_000 * 3 + 1, "泊松样本上限 = 3×base");
  }
});

// ---------- 端点/候选随机化 ----------

test("shuffle: 多重集不变、顺序充分随机", () => {
  const src = Array.from({ length: 20 }, (_, i) => `ip-${i}`);
  const out = shuffle(src);
  assert.deepEqual([...out].sort(), [...src].sort(), "多重集必须不变");
  assert.deepEqual(src, Array.from({ length: 20 }, (_, i) => `ip-${i}`), "原数组不被修改");
  const same = out.every((v, i) => v === src[i]);
  assert.ok(!same, "20 个元素洗牌后不应保持原序");
  assert.equal(shuffle([]).length, 0);
  assert.equal(shuffle(null).length, 0);
});

test("pickEndpoints: keep 截断样本集,keep<=0 只洗牌不截断", () => {
  const src = ["a", "b", "c", "d", "e"];
  for (let i = 0; i < 20; i++) {
    const picked = pickEndpoints(src, 2);
    assert.equal(picked.length, 2);
    for (const p of picked) { assert.ok(src.includes(p), `抽样必须来自原集: ${p}`); }
    assert.ok(new Set(picked).size === 2, "不能重复抽同一个");
  }
  assert.equal(pickEndpoints(src, 0).length, 5, "keep=0 = 全部");
  assert.equal(pickEndpoints(src, 99).length, 5, "keep 超集 = 全部");
  const sorted1 = [...pickEndpoints(src, 0)].sort().join();
  assert.equal(sorted1, "a,b,c,d,e", "keep=0 时多重集不变");
});
