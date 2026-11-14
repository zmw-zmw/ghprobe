// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 zmw
// v0.1.13 主慢换位：轻探活补上「快慢」维度 —— 主条目活着但 ttfb 超阈值时补测备选，
// 备选显著更快（< 60%）就换位（复用 promote 通道）。抖动期「活着但慢」的体感接近断。
import "./helpers.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { decide, parseBlock, buildHealthBlock, runHealth } from "../src/health.js";

const mkCurrent = () => parseBlock(buildHealthBlock(
  new Map([["github.com", "1.1.1.1"]]),
  new Map(),
  new Map([["github.com", ["2.2.2.2"]]]),
));
const mkCfg = (over = {}) => ({
  domains: ["github.com"], fallbacks: {}, doh: [],
  timeouts: { dohMs: 100, tcpMs: 120, tlsMs: 200, httpMs: 200 },
  probe: { concurrency: 4 },
  hosts: { maxEntriesPerDomain: 2 },
  schedule: { lightProbe: true },
  ...over,
});

test("主慢换位: 主活但 ttfb 超阈值 + 备选快 60% 以上 -> promote 换位", () => {
  const results = [
    { domain: "github.com", ip: "1.1.1.1", ok: true, ttfb: 1000, role: "main" },
    { domain: "github.com", ip: "2.2.2.2", ok: true, ttfb: 400, role: "alt" },
  ];
  const d = decide(results, mkCurrent(), mkCfg());
  assert.equal(d.action, "full", `应触发提上备选: ${d.reason}`);
  assert.equal(d.promote.get("github.com"), "2.2.2.2", "备选换进主位");
});

test("主慢换位: 备选只快一点点(未过 60% 线)不换,防横跳", () => {
  const results = [
    { domain: "github.com", ip: "1.1.1.1", ok: true, ttfb: 1000, role: "main" },
    { domain: "github.com", ip: "2.2.2.2", ok: true, ttfb: 700, role: "alt" },
  ];
  const d = decide(results, mkCurrent(), mkCfg());
  assert.equal(d.action, "none", `不应换位: ${d.reason}`);
  assert.equal(d.promote.size, 0);
});

test("主慢换位: 主条目 ttfb 未超阈值(默认 800ms)不触发", () => {
  const results = [
    { domain: "github.com", ip: "1.1.1.1", ok: true, ttfb: 500, role: "main" },
    { domain: "github.com", ip: "2.2.2.2", ok: true, ttfb: 100, role: "alt" },
  ];
  const d = decide(results, mkCurrent(), mkCfg());
  assert.equal(d.action, "none");
});

test("主慢换位: slowSwapTtfbMs 设 0 整体关闭", () => {
  const results = [
    { domain: "github.com", ip: "1.1.1.1", ok: true, ttfb: 2000, role: "main" },
    { domain: "github.com", ip: "2.2.2.2", ok: true, ttfb: 100, role: "alt" },
  ];
  const d = decide(results, mkCurrent(), mkCfg({ schedule: { slowSwapTtfbMs: 0 } }));
  assert.equal(d.action, "none");
});

test("主慢换位: runHealth 轻探活对慢主条目补测备选", async () => {
  const hostsPath = (await import("node:fs")).mkdtempSync((await import("node:path")).join((await import("node:os")).tmpdir(), "ghprobe-v17-"));
  (await import("node:fs")).writeFileSync(hostsPath + "/hosts", buildHealthBlock(
    new Map([["github.com", "1.1.1.1"]]), new Map(), new Map([["github.com", ["2.2.2.2"]]])), "utf8");
  const calls = [];
  const r = await runHealth(mkCfg(), () => {}, false, hostsPath + "/hosts", new Map(), {}, {
    probeIp: async (domain, ip) => {
      calls.push(ip);
      return ip === "1.1.1.1"
        ? { domain, ip, ok: true, ttfb: 1000, err: "" }
        : { domain, ip, ok: true, ttfb: 400, err: "" };
    },
    detectProxy: async () => ({ found: false, alive: false }),
    runProbe: async () => ({ ranked: new Map(), extra: new Map(), raw: [] }),
  });
  assert.ok(calls.includes("2.2.2.2"), `慢主条目应补测备选: ${calls}`);
  assert.ok(r.action === "full" || r.promote, `应产生换位决策: ${JSON.stringify(r).slice(0, 200)}`);
});
