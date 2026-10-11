// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 zmw
// config 合并单测：验证用户只覆盖子属性时不会清空默认兄弟属性
import "./helpers.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadConfig, userConfigPath, ensureUserConfig, normalizeFallbacks } from "../src/config.js";

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

// ── 用户配置文件：install 生成、用户可编辑、优先于包内默认 ──────────
test("userConfigPath: 落在用户数据目录下（且被测试隔离到临时目录）", () => {
  assert.ok(userConfigPath().endsWith(path.join("ghprobe", "config.yaml")));
  assert.ok(userConfigPath().startsWith(process.env.GHPROBE_TEST_DATA_DIR), "测试必须隔离，否则会读到本机真实配置");
});

test("ensureUserConfig: 首次生成、二次不覆盖（保留用户改动）", () => {
  const p = ensureUserConfig();
  assert.ok(fs.existsSync(p), "首次应生成用户配置");
  assert.ok(fs.readFileSync(p, "utf8").includes("poolUpdate"), "生成的配置应含 poolUpdate 段");

  fs.writeFileSync(p, "schedule:\n  healthMin: 9\n", "utf8");
  ensureUserConfig();
  assert.ok(fs.readFileSync(p, "utf8").includes("healthMin: 9"), "已存在时不得覆盖用户改动");
});

test("loadConfig: 用户目录 config.yaml 生效，且深合并保留未覆盖的默认键", () => {
  const p = userConfigPath();
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, "schedule:\n  healthMin: 7\n", "utf8");
  try {
    const cfg = loadConfig();
    assert.equal(cfg.schedule.healthMin, 7);
    assert.equal(cfg.schedule.absentCooldownHours, 1, "未覆盖的兄弟键应保留默认值");
  } finally {
    fs.unlinkSync(p);
  }
});

// ============================================================================
// 2026-10-11 新增：fallbacks 支持「自带探测判据」的完整写法
// 动机：兜底域名本身也会被封（实测 cdn.jsdelivr.net 在当前网络下 TLS 被掐），
//       所以要给多个候选；而不同替身的 URL 形态不同（CDN 映射 vs 代理前缀），
//       判据不能写死在代码里 —— 必须跟着配置走。
// ============================================================================

test("normalizeFallbacks: 简写（字符串）保持原语义", () => {
  const cfg = normalizeFallbacks({ fallbacks: { "raw.githubusercontent.com": ["cdn.jsdelivr.net"] } });
  assert.deepEqual(cfg.fallbacks["raw.githubusercontent.com"], ["cdn.jsdelivr.net"]);
  assert.deepEqual(cfg.fallbackSigs, {}, "简写不带判据");
});

test("normalizeFallbacks: 完整写法抽出 domain 与判据", () => {
  const cfg = normalizeFallbacks({
    fallbacks: {
      "raw.githubusercontent.com": [
        "cdn.jsdelivr.net",
        { domain: "ghproxy.net", path: "/https://raw.githubusercontent.com/torvalds/linux/master/README", mustContain: ["Linux kernel"] },
      ],
    },
  });
  assert.deepEqual(cfg.fallbacks["raw.githubusercontent.com"], ["cdn.jsdelivr.net", "ghproxy.net"]);
  assert.equal(cfg.fallbackSigs["ghproxy.net"].path, "/https://raw.githubusercontent.com/torvalds/linux/master/README");
  assert.deepEqual(cfg.fallbackSigs["ghproxy.net"].mustContain, ["Linux kernel"]);
  assert.equal(cfg.fallbackSigs["cdn.jsdelivr.net"], undefined);
});

test("normalizeFallbacks: 只给 domain 不带判据时不产生空 sig", () => {
  const cfg = normalizeFallbacks({ fallbacks: { "a.com": [{ domain: "b.com" }] } });
  assert.deepEqual(cfg.fallbacks["a.com"], ["b.com"]);
  assert.deepEqual(cfg.fallbackSigs, {});
});

test("normalizeFallbacks: 缺 fallbacks 段时不炸", () => {
  const cfg = normalizeFallbacks({});
  assert.deepEqual(cfg.fallbacks, {});
  assert.deepEqual(cfg.fallbackSigs, {});
});

test("loadConfig: 默认配置的 raw 兜底有多个候选且带判据", () => {
  const cfg = loadConfig();
  const list = cfg.fallbacks["raw.githubusercontent.com"];
  assert.ok(list.length >= 2, "应给多个候选（单个被封时还有备选）");
  assert.ok(list.includes("cdn.jsdelivr.net"));
  // 代理型替身自带判据
  assert.ok(cfg.fallbackSigs["ghproxy.net"], "代理型替身必须自带 path/mustContain");
  assert.ok(cfg.fallbackSigs["ghproxy.net"].path.startsWith("/https://"));
});
