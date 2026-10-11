// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 zmw
// 离线单测：hosts 块生成与合并替换 + 跨进程写锁
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { buildBlock, mergeHosts, acquireHostsLock, releaseHostsLock, HOSTS_LOCK, buildElevateCommand, runElevationWrapper } from "../src/hosts.js";

const ranked = new Map([["github.com", [{ ip: "20.205.243.166" }, { ip: "20.27.177.113" }]]]);
const extra = new Map([["cdn.jsdelivr.net", [{ ip: "104.16.0.1" }]]]);

test("buildBlock: 含 begin/end 标记与条目", () => {
  const block = buildBlock(ranked, extra);
  assert.ok(block.startsWith("# === ghprobe begin ==="));
  assert.ok(block.endsWith("# === ghprobe end ==="));
  assert.ok(block.includes("20.205.243.166 github.com"));
  assert.ok(block.includes("104.16.0.1 cdn.jsdelivr.net"));
});

test("mergeHosts: 替换旧块且保留其他行", () => {
  const current = ["# 本机原有条目", "127.0.0.1 localhost", "# === ghprobe begin ===", "9.9.9.9 old.com", "# === ghprobe end ===", "# 尾注"].join("\n");
  const merged = mergeHosts(current, buildBlock(ranked, extra));
  assert.ok(merged.includes("127.0.0.1 localhost"));
  assert.ok(merged.includes("# 尾注"));
  assert.ok(!merged.includes("9.9.9.9 old.com"));
  assert.equal((merged.match(/ghprobe begin/g) || []).length, 1);
  assert.ok(merged.endsWith("\n"));
});

test("mergeHosts: 无旧块时追加", () => {
  const merged = mergeHosts("127.0.0.1 localhost", buildBlock(ranked, new Map()));
  assert.ok(merged.includes("20.205.243.166 github.com"));
  assert.ok(merged.includes("127.0.0.1 localhost"));
});

test("acquireHostsLock: 独占 + 冲突超时放弃 + 释放后可再拿", () => {
  try { fs.unlinkSync(HOSTS_LOCK); } catch { /* 无残留即无锁 */ }
  const fd = acquireHostsLock(800, 50);
  assert.ok(fd != null, "首次应拿到锁");
  const fd2 = acquireHostsLock(300, 50);
  assert.equal(fd2, null, "已被持有，短暂自旋后放弃本轮");
  releaseHostsLock(fd);
  const fd3 = acquireHostsLock(800, 50);
  assert.ok(fd3 != null, "释放后应能再次拿到");
  releaseHostsLock(fd3);
});

// ── 提权假成功回归（B1）──────────────────────────────────────────────
// 旧写法 `$p = Start-Process … -Verb RunAs …; exit $p.ExitCode` 在用户取消 UAC 时，
// Start-Process 抛的是非终止错误 → 脚本继续 → $p 仍为 $null → `exit $null` = 退出码 0
// → applyHosts 以为写成功，对外报「hosts 已写入」。下面两条锁住这个回归。
test("buildElevateCommand: 判空必须早于 exit $p.ExitCode", () => {
  const cmd = buildElevateCommand("powershell", ["-NoProfile", "-File", "C:\\tmp\\x.ps1"]);
  const iNull = cmd.indexOf("$null -eq $p");
  const iExit = cmd.lastIndexOf("exit $p.ExitCode");
  assert.notEqual(iNull, -1, "缺少 $p 判空保护：提权失败会被伪装成成功");
  assert.notEqual(iExit, -1, "缺少 exit $p.ExitCode：拿不到被提升进程的退出码");
  assert.ok(iNull < iExit, "判空必须发生在使用 $p.ExitCode 之前");
  assert.ok(cmd.includes("-ErrorAction Stop"), "Start-Process 必须带 -ErrorAction Stop，否则失败不是终止错误");
});

test("runElevationWrapper: Start-Process 自身失败必须返回非零退出码", { skip: process.platform !== "win32" }, async () => {
  // 用一个必然不存在的目标让 Start-Process 立刻失败（不会弹 UAC）
  const r = await runElevationWrapper("C:\\nope\\nope-does-not-exist.exe", []);
  assert.notEqual(r.code, 0, `提权失败被伪装成成功（code=${r.code}），applyHosts 会误报「hosts 已写入」`);
});
