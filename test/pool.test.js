// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 zmw
// 候选池更新离线单测：CIDR 展开、缓存读写、更新判定（不联网）
import "./helpers.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expandCidr, poolCachePath, readPoolCache, poolNeedsUpdate, seedIps, fetchFirstMeta } from "../src/pool.js";

test("expandCidr: /32 直接返回该 IP", () => {
  assert.deepEqual(expandCidr("20.201.28.151/32"), ["20.201.28.151"]);
});

// 🔴 大段绝不能全展开：meta 的 web 段里有 /20（4096 个地址），全展开会让探测成本爆炸
test("expandCidr: 大段只采样前几个（从段内 .3 起）", () => {
  assert.deepEqual(expandCidr("140.82.112.0/20", 4), ["140.82.112.3", "140.82.112.4", "140.82.112.5", "140.82.112.6"]);
  assert.ok(expandCidr("140.82.112.0/20", 4).length <= 4);
});

test("expandCidr: 采样不越过网段边界", () => {
  assert.deepEqual(expandCidr("192.0.2.0/30", 4), ["192.0.2.3"]); // /30 只有 4 个地址
});

test("expandCidr: IPv6 与非法输入返回空数组", () => {
  assert.deepEqual(expandCidr("2a0a:a440::/29"), []);
  assert.deepEqual(expandCidr(""), []);
  assert.deepEqual(expandCidr("not-an-ip/24"), []);
  assert.deepEqual(expandCidr("999.1.1.1/32"), []);
});

test("seedIps: 合并 seed + azure + fastly 并去重", () => {
  const cfg = { ipPools: { seed: ["1.1.1.1"], azure: ["1.1.1.1", "2.2.2.2"], fastly: ["3.3.3.3"] } };
  assert.deepEqual(seedIps(cfg), ["1.1.1.1", "2.2.2.2", "3.3.3.3"]);
});

test("poolCachePath: 落在用户数据目录下", () => {
  assert.ok(poolCachePath().endsWith(path.join("ghprobe", "pool.cache.json")));
});

test("poolNeedsUpdate: 无缓存该更新 / 成功且新鲜不该 / 失败冷却内不该 / 过了一个周期该", () => {
  const orig = process.env.LOCALAPPDATA;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ghprobe-pooltest-"));
  process.env.LOCALAPPDATA = tmp;
  try {
    const cfg = { poolUpdate: { enabled: true, intervalHours: 24 } };
    assert.equal(poolNeedsUpdate(cfg), true, "没有缓存时应更新");

    const p = poolCachePath();
    fs.mkdirSync(path.dirname(p), { recursive: true });
    const now = new Date().toISOString();

    fs.writeFileSync(p, JSON.stringify({ at: now, lastAttempt: now, ips: ["1.1.1.1"] }));
    assert.equal(poolNeedsUpdate(cfg), false, "刚成功过不应再更新");
    assert.deepEqual(readPoolCache().ips, ["1.1.1.1"]);

    // 🔴 失败也走同一档冷却：拉 meta 走 api.github.com，被 SNI 封锁时重试无意义，
    //    还会白撞 60 次/小时限制 —— 所以失败后同样等满 intervalHours。
    fs.writeFileSync(p, JSON.stringify({ lastAttempt: now, lastError: "boom" }));
    assert.equal(poolNeedsUpdate(cfg), false, "失败冷却内不应重试");

    fs.writeFileSync(p, JSON.stringify({ lastAttempt: "2000-01-01T00:00:00.000Z", lastError: "boom" }));
    assert.equal(poolNeedsUpdate(cfg), true, "失败超过一个周期后应重试");

    fs.writeFileSync(p, JSON.stringify({ at: "2000-01-01T00:00:00.000Z", lastAttempt: "2000-01-01T00:00:00.000Z" }));
    assert.equal(poolNeedsUpdate(cfg), true, "过期后应更新");
  } finally {
    process.env.LOCALAPPDATA = orig;
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* 忽略 */ }
  }
});

test("poolNeedsUpdate: enabled=false 时永不更新", () => {
  assert.equal(poolNeedsUpdate({ poolUpdate: { enabled: false } }), false);
});

// 种子为空时必须立刻 reject（不能挂住）：并发逻辑里 left 初值为 0，若不特判则 Promise 永不 settle
test("fetchFirstMeta: 种子为空 -> 立即 reject", async () => {
  await assert.rejects(() => fetchFirstMeta([], "api.github.com", "/meta", 100), /没有可用种子/);
});

test("readPoolCache: 文件不存在/损坏时返回 null，不抛", () => {
  const orig = process.env.LOCALAPPDATA;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ghprobe-pooltest2-"));
  process.env.LOCALAPPDATA = tmp;
  try {
    assert.equal(readPoolCache(), null);
    const p = poolCachePath();
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, "{ not json");
    assert.equal(readPoolCache(), null);
  } finally {
    process.env.LOCALAPPDATA = orig;
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* 忽略 */ }
  }
});
