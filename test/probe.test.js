// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 zmw
// 离线单测：候选池分配（不联网）
import { test } from "node:test";
import assert from "node:assert/strict";
import { poolsForDomain } from "../src/probe.js";
import { loadConfig } from "../src/config.js";

const cfg = {
  ipPools: { fastly: ["1.1.1.1", "1.1.1.2"], azure: ["2.2.2.1", "2.2.2.2", "2.2.2.3"] },
  domainPools: {
    "github.com": ["azure"],
    "raw.githubusercontent.com": ["fastly"],
    "cdn.jsdelivr.net": ["no-such-pool"],
  },
};

test("poolsForDomain: 配了 domainPools 就只取指定池", () => {
  assert.deepEqual(poolsForDomain(cfg, "github.com"), ["2.2.2.1", "2.2.2.2", "2.2.2.3"]);
  assert.deepEqual(poolsForDomain(cfg, "raw.githubusercontent.com"), ["1.1.1.1", "1.1.1.2"]);
});

test("poolsForDomain: 未配置的域名用全部池", () => {
  assert.deepEqual(
    poolsForDomain(cfg, "unknown.example.com").sort(),
    ["1.1.1.1", "1.1.1.2", "2.2.2.1", "2.2.2.2", "2.2.2.3"],
  );
});

// 池名写错时绝不能返回空 —— 返回空 = 该域名没有任何内置候选，
// 一旦 DoH 结果也被污染就直接 stuck（这正是本次线上问题的形态）。
test("poolsForDomain: 池名写错时退回全部池，绝不返回空", () => {
  const picked = poolsForDomain(cfg, "cdn.jsdelivr.net");
  assert.equal(picked.length, 5);
});

test("poolsForDomain: 没配 domainPools 时用全部池（向后兼容旧配置）", () => {
  assert.deepEqual(poolsForDomain({ ipPools: { a: ["9.9.9.9"] } }, "github.com"), ["9.9.9.9"]);
});

test("默认配置：每个目标域名都配了 domainPools，且池名都真实存在", () => {
  const c = loadConfig();
  for (const d of c.domains) {
    const names = c.domainPools?.[d];
    assert.ok(Array.isArray(names) && names.length > 0, `${d} 缺 domainPools`);
    for (const n of names) { assert.ok(c.ipPools?.[n]?.length, `${d} 指向了不存在的池 ${n}`); }
  }
});

// github.com 主站必须能拿到内置池里的候选（本次故障的直接回归）
test("默认配置：github.com 的内置池非空且含 GitHub 自租段", () => {
  const c = loadConfig();
  const pool = poolsForDomain(c, "github.com");
  assert.ok(pool.length >= 8, `github.com 内置候选太少: ${pool.length}`);
  assert.ok(pool.includes("20.29.134.23"), "缺少 2026-10 实测可用的 GitHub 自租段 IP");
});
