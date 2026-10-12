// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 zmw
// config 合并单测：验证用户只覆盖子属性时不会清空默认兄弟属性
import "./helpers.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadConfig, userConfigPath, ensureUserConfig, normalizeFallbacks, mergeThreeWay, deepEqual, userConfigSnapshotPath } from "../src/config.js";

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
        { domain: "mirror.example.net", path: "/https://raw.githubusercontent.com/torvalds/linux/master/README", mustContain: ["Linux kernel"] },
      ],
    },
  });
  assert.deepEqual(cfg.fallbacks["raw.githubusercontent.com"], ["cdn.jsdelivr.net", "mirror.example.net"]);
  assert.equal(cfg.fallbackSigs["mirror.example.net"].path, "/https://raw.githubusercontent.com/torvalds/linux/master/README");
  assert.deepEqual(cfg.fallbackSigs["mirror.example.net"].mustContain, ["Linux kernel"]);
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

test("loadConfig: 默认配置的 raw 兜底只含公共 CDN，不预置第三方代理", () => {
  const cfg = loadConfig();
  const list = cfg.fallbacks["raw.githubusercontent.com"];
  assert.ok(list.includes("cdn.jsdelivr.net"));
  assert.equal(cfg.fallbackSigs["ghproxy.net"], undefined, "默认不得预置第三方代理域名");
  assert.equal(cfg.fallbackSigs["gh-proxy.com"], undefined, "默认不得预置第三方代理域名");
});

// ============================================================================
// 2026-10-11 新增：三方合并 —— 让「默认值的改进」能到达老用户
// 问题：用户配置是 install 时整份复制的，且优先于包内默认 -> 默认里**已有键**的新值永远到不了老用户。
// 解法：install 时存一份默认快照；用户值 == 快照值 => 这个键他没动过 => 用新默认。
// ============================================================================

test("deepEqual: 数组看元素顺序，对象不看键顺序", () => {
  assert.equal(deepEqual([1, 2], [1, 2]), true);
  assert.equal(deepEqual([1, 2], [2, 1]), false);
  assert.equal(deepEqual({ a: 1, b: 2 }, { b: 2, a: 1 }), true);
  assert.equal(deepEqual({ a: [1] }, { a: [1] }), true);
  assert.equal(deepEqual({ a: 1 }, { a: 1, b: 2 }), false);
  assert.equal(deepEqual(1, "1"), false);
  assert.equal(deepEqual(null, undefined), false);
});

test("mergeThreeWay: 没有快照 -> 退回「用户值优先」（不敢猜）", () => {
  const def = { a: 1, b: 2 };
  const user = { a: 9 };
  assert.deepEqual(mergeThreeWay(def, user, null), { a: 9, b: 2 });
});

test("mergeThreeWay: 用户值 == 快照值 -> 用新默认（关键用例）", () => {
  // 用户没动过 fallbacks；默认里给它加了两个候选 -> 老用户应该拿到
  const snap = { fallbacks: { "raw.githubusercontent.com": ["cdn.jsdelivr.net"] } };
  const user = { fallbacks: { "raw.githubusercontent.com": ["cdn.jsdelivr.net"] } };
  const def = { fallbacks: { "raw.githubusercontent.com": ["cdn.jsdelivr.net", "mirror-a.example.net", "mirror-b.example.net"] } };
  const out = mergeThreeWay(def, user, snap);
  assert.deepEqual(out.fallbacks["raw.githubusercontent.com"], ["cdn.jsdelivr.net", "mirror-a.example.net", "mirror-b.example.net"]);
});

test("mergeThreeWay: 用户值 != 快照值 -> 保留用户值（不覆盖自定义）", () => {
  const snap = { schedule: { healthMin: 1 } };
  const user = { schedule: { healthMin: 5 } };   // 用户改过
  const def = { schedule: { healthMin: 1, absentCooldownHours: 1 } };
  const out = mergeThreeWay(def, user, snap);
  assert.equal(out.schedule.healthMin, 5, "用户改过的值必须保留");
  assert.equal(out.schedule.absentCooldownHours, 1, "新键仍要从默认带进来");
});

test("mergeThreeWay: 用户自己加的键保留；默认里的新键带上", () => {
  const snap = { a: 1 };
  const user = { a: 1, myOwn: "keep-me" };
  const def = { a: 1, brandNew: "from-default" };
  const out = mergeThreeWay(def, user, snap);
  assert.equal(out.myOwn, "keep-me");
  assert.equal(out.brandNew, "from-default");
});

test("mergeThreeWay: 嵌套对象逐层判断（一层没改、一层改了）", () => {
  const snap = { timeouts: { tcpMs: 2500, tlsMs: 6000 } };
  const user = { timeouts: { tcpMs: 2500, tlsMs: 3000 } };  // 只改了 tlsMs
  const def = { timeouts: { tcpMs: 1500, tlsMs: 6000 } };   // 默认改了 tcpMs
  const out = mergeThreeWay(def, user, snap);
  assert.equal(out.timeouts.tcpMs, 1500, "没改过的键跟随新默认");
  assert.equal(out.timeouts.tlsMs, 3000, "改过的键保留用户值");
});

test("ensureUserConfig: 首次生成用户配置时同时写快照；二次调用不覆盖两者", () => {
  const orig = process.env.LOCALAPPDATA;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ghprobe-snap-"));
  process.env.LOCALAPPDATA = tmp;
  try {
    const p = userConfigPath();
    const sp = userConfigSnapshotPath();
    assert.equal(fs.existsSync(p), false);
    ensureUserConfig();
    assert.equal(fs.existsSync(p), true, "应生成用户配置");
    assert.equal(fs.existsSync(sp), true, "应同时生成快照");

    // 用户改了配置；再 install 不能覆盖用户配置，也不能刷新快照（基准不能漂）
    fs.writeFileSync(p, "domains: [github.com]\n", "utf8");
    fs.writeFileSync(sp, "# user-marker\n", "utf8");
    ensureUserConfig();
    assert.match(fs.readFileSync(p, "utf8"), /domains: \[github\.com\]/);
    assert.match(fs.readFileSync(sp, "utf8"), /user-marker/);
  } finally {
    process.env.LOCALAPPDATA = orig;
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* 忽略 */ }
  }
});

test("loadConfig: 用户配置里没改过的键跟随新默认（端到端）", () => {
  const orig = process.env.LOCALAPPDATA;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ghprobe-3way-"));
  process.env.LOCALAPPDATA = tmp;
  try {
    // 快照 = 默认（模拟 install），用户配置 = 默认 + 一处自定义
    ensureUserConfig();
    const p = userConfigPath();
    const user = fs.readFileSync(p, "utf8").replace(/healthMin: 1/, "healthMin: 9");
    fs.writeFileSync(p, user, "utf8");

    const cfg = loadConfig();
    assert.equal(cfg.schedule.healthMin, 9, "用户改过的键保留");
    // 没改过的键（兜底候选）应跟随当前默认：只剩公共 CDN，不预置第三方代理
    assert.deepEqual(cfg.fallbacks["raw.githubusercontent.com"], ["cdn.jsdelivr.net"]);
  } finally {
    process.env.LOCALAPPDATA = orig;
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* 忽略 */ }
  }
});
