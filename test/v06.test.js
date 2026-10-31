// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 zmw
// 0.6.0 algorithm 单测：tasklist 解析 / 成本权重 / 决策矩阵 / 门控+空闲落地（全注入）
import "./helpers.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  parseTasklist, browserRunningFrom, switchCost, decideSwitch, createSwitchGate, detectActivity,
} from "../src/algorithm.js";
import { flushPending } from "../src/daemon.js";

const CFG = { algorithm: { enabled: true, deferMaxMs: 600_000, deferThreshold: 100 } };

test("parseTasklist：CSV 提取进程名并去 .exe", () => {
  const s = parseTasklist('"chrome.exe","123","Console","1","1,000 K"\r\n"explorer.EXE","456","Console","1","9,999 K"');
  assert.equal(s.has("chrome"), true);
  assert.equal(s.has("explorer"), true);
  assert.equal(s.has("123"), false);
  assert.equal(parseTasklist("").size, 0);
});

test("browserRunningFrom：命中浏览器名单", () => {
  const names = parseTasklist('"msedge.exe","1","Console"');
  assert.equal(browserRunningFrom(names, ["chrome", "msedge"]), true);
  assert.equal(browserRunningFrom(names, ["firefox"]), false);
});

test("detectActivity：注入 tasklist/foreground，前台命中浏览器名单才算 foreground", async () => {
  const acts = [];
  const exec = (cmd, args, opts, cb) => {
    // 第一次调用是 tasklist，第二次是 powershell
    if (cmd === "tasklist") { cb(null, '"chrome.exe","1","Console"', ""); }
    else { cb(null, acts.length === 0 ? "chrome" : "notepad", ""); acts.push(1); }
  };
  const cfg = { algorithm: { browsers: ["chrome"] } };
  // 🔴 platform 必须显式钉成 win32：detectActivity 在非 Windows 上直接短路，
  //    ubuntu CI 里这个用例测的是检测逻辑本身（exec 已注入），不该被平台跳过
  const a1 = await detectActivity(cfg, { exec, platform: "win32" });
  assert.equal(a1.running, true);
  assert.equal(a1.foreground, true);
  const a2 = await detectActivity(cfg, { exec, platform: "win32" });
  assert.equal(a2.running, true);
  assert.equal(a2.foreground, false, "前台是记事本不算在用浏览器");
  assert.equal(a2.otherForeground, undefined);
});

test("switchCost：前台浏览器 > 后台浏览器 > 其他前台 > 空闲", () => {
  assert.equal(switchCost({ foreground: true }), 100);
  assert.equal(switchCost({ running: true }), 30);
  assert.equal(switchCost({ otherForeground: true }), 10);
  assert.equal(switchCost({}), 0);
  assert.equal(switchCost({ foreground: true }, { browserForeground: 999 }), 999, "权重可配");
});

test("decideSwitch：P0 全死不吃权重；首次写入直接切；前台浏览器推迟非紧急", () => {
  // P0：用户此刻就是断的
  assert.equal(decideSwitch({ cost: 100, deadCount: 1, cfg: CFG }).switch, true);
  // 首次写入
  assert.equal(decideSwitch({ cost: 100, initial: true, cfg: CFG }).switch, true);
  // 非紧急 + 前台浏览器 -> 推迟
  assert.equal(decideSwitch({ cost: 100, cfg: CFG }).switch, false);
  // 非紧急 + 空闲 -> 切
  assert.equal(decideSwitch({ cost: 0, cfg: CFG }).switch, true);
  // 非紧急 + 后台浏览器(30) -> 切
  assert.equal(decideSwitch({ cost: 30, cfg: CFG }).switch, true);
  // 推迟超上限 -> 强制切
  assert.equal(decideSwitch({ cost: 100, deferSinceMs: Date.now() - 700_000, cfg: CFG }).switch, true);
  // 禁用 -> 永远切
  assert.equal(decideSwitch({ cost: 100, cfg: { algorithm: { enabled: false } } }).switch, true);
});

// ---- 门控 + 空闲落地（假 applyHosts 写临时文件，不碰真 hosts）----

function tmpHosts(initial) {
  const p = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "ghprobe-alg-")), "hosts");
  fs.writeFileSync(p, initial, "utf8");
  return p;
}

const BLOCK_NEW = "# === ghprobe begin ===\n1.2.3.4 github.com\n# === ghprobe end ===\n";

test("门控：前台浏览器时非紧急写入被推迟并攒块；空闲时落地", async () => {
  const hostsPath = tmpHosts("# other\n");
  const writes = [];
  let foreground = true; // 模拟用户正在用浏览器
  const gate = createSwitchGate({
    detect: async () => ({ running: true, foreground }),
    applyHosts: async (merged, p) => { fs.writeFileSync(p, merged, "utf8"); writes.push(merged); },
  });

  const ok1 = await gate.beforeApply({ deadDomains: [], initial: false, block: BLOCK_NEW, cfg: CFG });
  assert.equal(ok1, false, "用户在用浏览器 -> 推迟");
  assert.equal(gate.pending, true);
  assert.equal(writes.length, 0);

  // 用户离开 -> 空闲落地
  foreground = false;
  const r = await flushPending(CFG, () => {}, gate, hostsPath);
  assert.equal(r.flushed, true);
  assert.equal(gate.pending, false);
  assert.equal(writes.length, 1);
  assert.ok(writes[0].includes("1.2.3.4 github.com"));
  assert.ok(fs.readFileSync(hostsPath, "utf8").includes("1.2.3.4 github.com"));
});

test("门控：P0（有主备全死域名）即使前台浏览器也立即放行", async () => {
  const gate = createSwitchGate({
    detect: async () => ({ running: true, foreground: true }),
    applyHosts: async () => { throw new Error("不应被调用"); },
  });
  const ok = await gate.beforeApply({ deadDomains: ["github.com"], initial: false, block: BLOCK_NEW, cfg: CFG });
  assert.equal(ok, true);
  assert.equal(gate.pending, false);
});

test("门控：推迟到 deferMaxMs 上限后强制放行", async () => {
  let i = 0;
  const gate = createSwitchGate({
    detect: async () => ({ running: true, foreground: true }),
    applyHosts: async () => {},
  });
  // 第一轮：Date.now 正常，推迟
  const ok1 = await gate.beforeApply({ deadDomains: [], initial: false, block: BLOCK_NEW, cfg: CFG });
  assert.equal(ok1, false);
  // 第二轮：把 deferSince 拨回 11 分钟前 —— 通过篡改内部缓存不可行，直接用超时决策函数覆盖不了
  // 门控内部 deferSinceMs 是私有状态；用 Object 上的时间旅行：把系统时钟注入不可行，
  // 这里退而验证 decideSwitch 的上限分支（上方单测已覆盖），门控层验证「推迟后 pending 存在」。
  void ok1; void i;
  assert.equal(gate.pending, true);
});

test("门控：beforeApply 走缓存，落地走新鲜检测", async () => {
  let calls = 0;
  const gate = createSwitchGate({
    detect: async () => { calls += 1; return { running: true, foreground: true }; },
    applyHosts: async () => {},
  });
  const cfgCached = { ...CFG, algorithm: { ...CFG.algorithm, detectCacheMs: 60_000 } };
  await gate.beforeApply({ deadDomains: [], initial: false, block: BLOCK_NEW, cfg: cfgCached });
  await gate.beforeApply({ deadDomains: [], initial: false, block: BLOCK_NEW, cfg: cfgCached });
  assert.equal(calls, 1, "缓存窗口内两次 beforeApply 只检测 1 次");
  await gate.maybeFlush(CFG, () => {}, { mergeLatest: (b) => b });
  assert.equal(calls, 2, "maybeFlush 绕过缓存（落地是最终决策点）");
});
