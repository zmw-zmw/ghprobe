// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 zmw
// v0.1.8 代理保活待命：注释条目（# idle）+ 节流保活探测 + 代理停止无缝恢复。
// 全部注入式；hosts 读写都指向临时目录。
import "./helpers.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseBlock, buildHealthBlock, idleToActive, activeBlockToIdle, runHealth } from "../src/health.js";
import { daemonCycle } from "../src/daemon.js";
import { evaluateHosts } from "../src/doctor.js";
import { buildStatusReport } from "../src/status.js";

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "ghprobe-v09-"));
}

function writeHosts(dir, content) {
  const p = path.join(dir, "hosts");
  fs.writeFileSync(p, content, "utf8");
  return p;
}

// ---------- idle 编码 ----------

test("idle 编码: 块注释行解析回 Map,proxy-idle 标记带时间", () => {
  const entries = new Map([["github.com", "1.2.3.4"]]);
  const extras = new Map([["github.com", ["5.6.7.8"]]]);
  const block = buildHealthBlock(entries, new Map(), extras, new Map(), new Map(), true);
  const parsed = parseBlock(block);
  assert.deepEqual(parsed.idle.get("github.com"), ["1.2.3.4", "5.6.7.8"], "主在前备选在后");
  assert.ok(parsed.idleSince, "要有 proxy-idle 时间标记");
  assert.equal(parsed.entries.size, 0, "对系统零生效：不能解析出活动条目");
});

test("idleToActive: 第一条转主、其余转备选", () => {
  const idle = new Map([["github.com", ["1.2.3.4", "5.6.7.8", "9.9.9.9"]]]);
  const { entries, extras } = idleToActive(idle);
  assert.equal(entries.get("github.com"), "1.2.3.4");
  assert.deepEqual(extras.get("github.com"), ["5.6.7.8", "9.9.9.9"]);
});

test("activeBlockToIdle: 活动块一行转注释块,absent/suspect 注释保留", () => {
  const active = buildHealthBlock(
    new Map([["github.com", "1.2.3.4"]]),
    new Map([["raw.githubusercontent.com", "2026-11-14T00:00:00.000Z"]]),
    new Map([["github.com", ["5.6.7.8"]]]),
    new Map(), new Map([["github.com", "2026-11-14T01:00:00.000Z"]]),
    false,
  );
  const idleBlock = activeBlockToIdle(active);
  const p = parseBlock(idleBlock);
  assert.deepEqual(p.idle.get("github.com"), ["1.2.3.4", "5.6.7.8"]);
  assert.equal(p.absent.get("raw.githubusercontent.com"), "2026-11-14T00:00:00.000Z", "absent 保留");
  assert.equal(p.suspect.get("github.com"), "2026-11-14T01:00:00.000Z", "suspect 保留");
});

// ---------- daemon 状态机:进入 / 保活节流 / 恢复 ----------

const PROXY_OK = async () => ({ found: true, alive: true, host: "127.0.0.1", port: 7890, kind: "test" });
const PROXY_DEAD = async () => ({ found: true, alive: false });

function baseCfg(over = {}) {
  return {
    domains: [], fallbacks: {},
    proxy: { enabled: true, idleProbeMin: 5 },
    schedule: {}, poolUpdate: { enabled: false },
    ...over,
  };
}

test("daemonCycle: 持续保活未到点 -> 零成本跳过;到点 -> 节流重测刷新 standby", async () => {
  const dir = tmpDir();
  const hostsPath = writeHosts(dir, buildHealthBlock(new Map(), new Map(), new Map(), new Map(), new Map(), true));
  let probes = 0;
  const ps = { wasAlive: true, endpoint: "127.0.0.1:7890", standbyAt: Date.now() - 10_000 };
  const r1 = await daemonCycle(baseCfg(), () => {}, {
    proxyState: ps, detectProxy: PROXY_OK, hostsPath,
    runProbe: async () => { probes += 1; return { ranked: new Map(), extra: new Map(), raw: [] }; },
    readHosts: () => fs.readFileSync(hostsPath, "utf8"),
    applyHosts: async () => { throw new Error("未到点不该写 hosts"); },
    hasNetwork: async () => { throw new Error("未到点不该走直连自愈"); },
  });
  assert.equal(r1.action, "none");
  assert.equal(r1.proxied, true);
  assert.equal(probes, 0, "standby 新鲜时不重测");

  ps.standbyAt = Date.now() - 6 * 60_000; // 过了 idleProbeMin
  const applied = [];
  const r2 = await daemonCycle(baseCfg(), () => {}, {
    proxyState: ps, detectProxy: PROXY_OK, hostsPath,
    runProbe: async () => { probes += 1; return { ranked: new Map([["github.com", [{ domain: "github.com", ip: "8.8.8.8", ok: true, score: 10 }]]]), extra: new Map(), raw: [] }; },
    readHosts: () => fs.readFileSync(hostsPath, "utf8"),
    applyHosts: async (merged) => { applied.push(merged); },
    hasNetwork: async () => false,
  });
  assert.equal(r2.action, "full");
  assert.equal(probes, 1, "到点保活重测");
  assert.match(applied[0], /# idle 8\.8\.8\.8 github\.com/, "standby 刷新");
});

test("daemonCycle: 保活探测全灭 -> 保留旧 standby 不覆盖", async () => {
  const dir = tmpDir();
  const oldIdle = buildHealthBlock(new Map([["github.com", "1.2.3.4"]]), new Map(), new Map(), new Map(), new Map(), true);
  const hostsPath = writeHosts(dir, oldIdle);
  const ps = { wasAlive: true, endpoint: "127.0.0.1:7890", standbyAt: Date.now() - 6 * 60_000 };
  const applied = [];
  await daemonCycle(baseCfg(), () => {}, {
    proxyState: ps, detectProxy: PROXY_OK, hostsPath,
    runProbe: async () => ({ ranked: new Map(), extra: new Map(), raw: [] }), // 全灭
    readHosts: () => fs.readFileSync(hostsPath, "utf8"),
    applyHosts: async (merged) => { applied.push(merged); },
    hasNetwork: async () => false,
  });
  assert.equal(applied.length, 0, "全灭时绝不写空 standby");
  assert.match(fs.readFileSync(hostsPath, "utf8"), /# idle 1\.2\.3\.4 github\.com/, "旧 standby 原样保留");
});

test("daemonCycle: 存活->死亡 -> 立即转正 standby(<1s 恢复)再校准", async () => {
  const dir = tmpDir();
  const idleBlock = buildHealthBlock(new Map([["github.com", "1.2.3.4"]]), new Map(), new Map([["github.com", ["5.6.7.8"]]]), new Map(), new Map(), true);
  const hostsPath = writeHosts(dir, idleBlock);
  const ps = { wasAlive: true, endpoint: "127.0.0.1:7890" };
  const applied = [];
  let probes = 0;
  const r = await daemonCycle(baseCfg(), () => {}, {
    proxyState: ps, detectProxy: PROXY_DEAD, hostsPath,
    runProbe: async () => { probes += 1; return { ranked: new Map([["github.com", [{ domain: "github.com", ip: "8.8.4.4", ok: true, score: 10 }]]]), extra: new Map(), raw: [] }; },
    readHosts: () => fs.readFileSync(hostsPath, "utf8"),
    applyHosts: async (merged) => { applied.push(merged); fs.writeFileSync(hostsPath, merged, "utf8"); return { ok: true }; },
    hasNetwork: async () => false,
  });
  assert.equal(r.action, "full");
  assert.equal(ps.wasAlive, false);
  assert.equal(probes, 1, "校准重测跑一次");
  assert.equal(applied.length >= 1, true);
  assert.match(applied[0], /^1\.2\.3\.4 github\.com$/m, "第一步必须先转正 standby");
  assert.match(applied[0], /^5\.6\.7\.8 github\.com$/m, "备选一并恢复");
  const final = fs.readFileSync(hostsPath, "utf8");
  assert.match(final, /^8\.8\.4\.4 github\.com$/m, "校准结果最终写回");
  assert.doesNotMatch(final, /# idle /m, "最终不应残留注释条目");
});

test("daemonCycle: 死亡恢复时重测全灭 -> 保留已恢复条目(全灭护栏)", async () => {
  const dir = tmpDir();
  const idleBlock = buildHealthBlock(new Map([["github.com", "1.2.3.4"]]), new Map(), new Map(), new Map(), new Map(), true);
  const hostsPath = writeHosts(dir, idleBlock);
  const ps = { wasAlive: true };
  const applied = [];
  const r = await daemonCycle(baseCfg(), () => {}, {
    proxyState: ps, detectProxy: PROXY_DEAD, hostsPath,
    runProbe: async () => ({ ranked: new Map(), extra: new Map(), raw: [] }), // 校准全灭
    readHosts: () => fs.readFileSync(hostsPath, "utf8"),
    applyHosts: async (merged) => { applied.push(merged); fs.writeFileSync(hostsPath, merged, "utf8"); return { ok: true }; },
    hasNetwork: async () => false,
  });
  assert.equal(r.action, "full");
  assert.match(fs.readFileSync(hostsPath, "utf8"), /^1\.2\.3\.4 github\.com$/m, "恢复的条目不能被空块抹掉");
});

// ---------- runHealth 的 idle 分支(监督者兜底) ----------

test("runHealth: 保活注释态 + 代理存活 -> 跳过,不重测不写", async () => {
  const dir = tmpDir();
  const hostsPath = writeHosts(dir, buildHealthBlock(new Map([["github.com", "1.2.3.4"]]), new Map(), new Map(), new Map(), new Map(), true));
  const cfg = baseCfg({ timeouts: { dohMs: 100, tcpMs: 120, tlsMs: 200, httpMs: 200 }, probe: { concurrency: 4, schannelRetry: false } });
  let probed = false;
  const r = await runHealth(cfg, () => {}, false, hostsPath, new Map(), {}, {
    detectProxy: PROXY_OK,
    applyHosts: async () => { throw new Error("保活模式下不该写"); },
  });
  assert.equal(r.action, "none");
  assert.equal(r.proxied, true);
});

test("runHealth: 保活注释态 + 代理死亡 -> 立即恢复(daemon 崩溃时的兜底)", async () => {
  const dir = tmpDir();
  const hostsPath = writeHosts(dir, buildHealthBlock(new Map([["github.com", "1.2.3.4"]]), new Map(), new Map([["github.com", ["5.6.7.8"]]]), new Map(), new Map(), true));
  const cfg = baseCfg({ timeouts: { dohMs: 100, tcpMs: 120, tlsMs: 200, httpMs: 200 }, probe: { concurrency: 4, schannelRetry: false } });
  const applied = [];
  const r = await runHealth(cfg, () => {}, true, hostsPath, new Map(), {}, {
    detectProxy: PROXY_DEAD,
    applyHosts: async (merged) => { applied.push(merged); return { ok: true }; },
  });
  assert.equal(r.action, "full");
  assert.match(applied[0], /^1\.2\.3\.4 github\.com$/m, "兜底路径同样先转正");
  assert.match(applied[0], /^5\.6\.7\.8 github\.com$/m);
});

// ---------- 展示 ----------

test("status: 保活模式展示待命信息", () => {
  const idleBlock = buildHealthBlock(new Map([["github.com", "1.2.3.4"]]), new Map(), new Map(), new Map(), new Map(), true);
  const lines = buildStatusReport({
    hostsContent: idleBlock,
    cfg: { domains: [], fallbacks: {} },
    logTail: [], daemon: null, task: null,
  });
  const idleLine = lines.find((l) => l.includes("代理保活模式"));
  assert.ok(idleLine && /1 个域名/.test(idleLine), `应展示保活行: ${idleLine}`);
  const hostsLine = lines.find((l) => l.startsWith("hosts："));
  assert.ok(/保活待命/.test(hostsLine), `hosts 行不能误导为「先跑 install」: ${hostsLine}`);
});

test("doctor evaluateHosts: 保活模式是 info 不是 fail", () => {
  const idleBlock = buildHealthBlock(new Map([["github.com", "1.2.3.4"]]), new Map(), new Map(), new Map(), new Map(), true);
  const { checks } = evaluateHosts(idleBlock, { domains: [], fallbacks: {} }, true);
  assert.equal(checks[0].status, "info");
  assert.ok(/代理保活模式/.test(checks[0].detail));
});
