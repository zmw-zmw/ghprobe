// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 zmw
// config 合并单测：验证用户只覆盖子属性时不会清空默认兄弟属性
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadConfig } from "../src/config.js";

function withUserYaml(body, fn) {
  const tmp = path.join(os.tmpdir(), `ghprobe-config-test-${Date.now()}.yaml`);
  fs.writeFileSync(tmp, body, "utf8");
  try { return fn(tmp); } finally { try { fs.unlinkSync(tmp); } catch { /* ignore */ } }
}

test("loadConfig: 无用户配置时返回默认配置", () => {
  const cfg = loadConfig();
  assert.ok(Array.isArray(cfg.domains));
  assert.ok(cfg.timeouts.dohMs > 0);
  assert.ok(cfg.timeouts.tlsMs > 0);
  assert.ok(cfg.timeouts.httpMs > 0);
});

test("loadConfig: 用户只覆盖 timeouts.tlsMs 不会清空 dohMs/httpMs", () => {
  const cfg = withUserYaml("timeouts:\n  tlsMs: 3000\n", (p) => loadConfig(p));
  assert.equal(cfg.timeouts.tlsMs, 3000);
  assert.equal(cfg.timeouts.dohMs, 5000);
  assert.equal(cfg.timeouts.httpMs, 6000);
});

test("loadConfig: 用户覆盖顶层数组直接替换", () => {
  const cfg = withUserYaml("domains:\n  - example.com\n", (p) => loadConfig(p));
  assert.deepEqual(cfg.domains, ["example.com"]);
  assert.equal(cfg.timeouts.dohMs, 5000);
});

test("loadConfig: 用户覆盖 probe 子对象合并", () => {
  const cfg = withUserYaml("probe:\n  concurrency: 1\n", (p) => loadConfig(p));
  assert.equal(cfg.probe.concurrency, 1);
  assert.equal(cfg.probe.maxCandidates, 8);
  assert.equal(cfg.probe.maxPerDomain, 4);
});
