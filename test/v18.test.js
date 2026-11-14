// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 zmw
// v0.1.13 死 IP 坟场：曾经验证过的 IP 永不丢失 —— 域名 stuck 时按「最近活过」复活。
import "./helpers.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { record, pick, load, save } from "../src/graveyard.js";
import { runHealth, buildHealthBlock } from "../src/health.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

test("坟场 record/pick: 只收曾活过的 IP,失败仅标记,活过失败的仍可被 pick", () => {
  const gy = {};
  record(gy, "github.com", [{ ip: "1.1.1.1", ok: true }]);           // 活过
  record(gy, "github.com", [{ ip: "1.1.1.1", ok: false }]);          // 后来死了 -> 留在坟场带 lastFail
  record(gy, "github.com", [{ ip: "6.6.6.6", ok: false }]);          // 从未活过的失败 -> 不收
  assert.equal(gy["github.com"].length, 1, "坟场只收曾经活过的");
  assert.ok(gy["github.com"][0].lastAlive > 0 && gy["github.com"][0].lastFail > 0);
  assert.deepEqual(pick(gy, "github.com"), ["1.1.1.1"], "曾活过的可被复活探测");
  record(gy, "github.com", [{ ip: "1.1.1.1", ok: true }]);           // 复活 -> lastFail 清掉
  assert.ok(!gy["github.com"][0].lastFail, "复活后 lastFail 应清除");
});

test("坟场 pick: 按最近活过排序 + exclude 排除 + limit 截断", () => {
  const gy = {};
  record(gy, "d", [{ ip: "1", ok: true }], 100);
  record(gy, "d", [{ ip: "2", ok: true }], 300);
  record(gy, "d", [{ ip: "3", ok: true }], 200);
  assert.deepEqual(pick(gy, "d", new Set(), 3), ["2", "3", "1"], "lastAlive 新的优先");
  assert.deepEqual(pick(gy, "d", new Set(["2"]), 3), ["3", "1"], "排除本轮已在候选的");
  assert.deepEqual(pick(gy, "d", new Set(), 2), ["2", "3"]);
  assert.deepEqual(pick(null, "d"), [], "null 坟场安全");
  assert.deepEqual(pick(gy, "d", new Set(), 0), [], "limit 0 = 关闭");
});

test("坟场 record: 单域名 24 条上限,最旧的被淘汰", () => {
  const gy = {};
  for (let i = 0; i < 30; i++) {
    record(gy, "d", [{ ip: `ip-${i}`, ok: true }], 1000 + i);
  }
  assert.equal(gy.d.length, 24);
  assert.ok(!gy.d.some((e) => e.ip === "ip-0"), "最旧的被淘汰");
  assert.ok(gy.d.some((e) => e.ip === "ip-29"), "最新的保留");
});

test("坟场 save/load 往返(临时目录,原子写)", () => {
  const gy = {};
  record(gy, "github.com", [{ ip: "9.9.9.1", ok: true }]);
  assert.ok(save(gy));
  const back = load();
  assert.deepEqual(back["github.com"].map((e) => e.ip), ["9.9.9.1"]);
});

test("集成: stuck 轮把坟场 IP 注入候选(runProbe 收到 extraByDomain)", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ghprobe-v18-"));
  const hostsPath = path.join(dir, "hosts");
  fs.writeFileSync(hostsPath, buildHealthBlock(new Map([["github.com", "1.1.1.1"]]), new Map(), new Map()), "utf8");
  const store = { "github.com": [{ ip: "9.9.9.2", lastAlive: 2 }, { ip: "9.9.9.1", lastAlive: 1 }] };
  const fakeGy = { load: () => store, pick: (g, d, e, l) => pick(g, d, e, l), record: () => {}, save: () => true };
  let captured = null;
  const cfg = {
    domains: ["github.com"], fallbacks: {}, doh: [],
    timeouts: { dohMs: 100, tcpMs: 120, tlsMs: 200, httpMs: 200 },
    probe: { concurrency: 4 },
    hosts: { maxEntriesPerDomain: 2 },
    schedule: { lightProbe: true },
  };
  const r = await runHealth(cfg, () => {}, false, hostsPath, new Map(), {}, {
    probeIp: async (domain, ip) => ({ domain, ip, ok: false, err: "timeout" }),  // 条目全死 -> stuck
    detectProxy: async () => ({ found: false, alive: false }),
    runProbe: async (c, log, diagnose, extraByDomain) => { captured = extraByDomain; return { ranked: new Map(), extra: new Map(), raw: [] }; },
    graveyard: fakeGy,
  });
  assert.deepEqual(captured.get("github.com"), ["9.9.9.2", "9.9.9.1"], `stuck 时应注入坟场 IP: ${captured.get("github.com")}`);
  assert.ok((r.stuck || []).includes("github.com"), "空 ranked 时该域名按 stuck 上报");
  assert.ok(["none", "full"].includes(r.action));
});

test("集成: graveyardMaxIps=0 关闭注入", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ghprobe-v18b-"));
  const hostsPath = path.join(dir, "hosts");
  fs.writeFileSync(hostsPath, buildHealthBlock(new Map([["github.com", "1.1.1.1"]]), new Map(), new Map()), "utf8");
  const store = { "github.com": [{ ip: "9.9.9.2", lastAlive: 2 }] };
  const fakeGy = { load: () => store, pick: (g, d, e, l) => pick(g, d, e, l), record: () => {}, save: () => true };
  let captured = null;
  const cfg = {
    domains: ["github.com"], fallbacks: {}, doh: [],
    timeouts: { dohMs: 100, tcpMs: 120, tlsMs: 200, httpMs: 200 },
    probe: { concurrency: 4, graveyardMaxIps: 0 },
    hosts: { maxEntriesPerDomain: 2 },
    schedule: { lightProbe: true },
  };
  await runHealth(cfg, () => {}, false, hostsPath, new Map(), {}, {
    probeIp: async (domain, ip) => ({ domain, ip, ok: false, err: "timeout" }),
    detectProxy: async () => ({ found: false, alive: false }),
    runProbe: async (c, log, diagnose, extraByDomain) => { captured = extraByDomain; return { ranked: new Map(), extra: new Map(), raw: [] }; },
    graveyard: fakeGy,
  });
  assert.ok(!captured || !captured.get("github.com"), "关闭后不应注入");
});
