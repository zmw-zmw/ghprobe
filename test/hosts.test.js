// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 zmw
// 离线单测：hosts 块生成与合并替换 + 跨进程写锁
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { buildBlock, mergeHosts, acquireHostsLock, releaseHostsLock, HOSTS_LOCK } from "../src/hosts.js";

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
