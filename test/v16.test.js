// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 zmw
// v0.1.13 主站模式：ghprobe minimal —— domains 收敛为 [github.com] + 兜底清空。
// 动机：githubusercontent 家族被精准黑洞（.133 四连全网无备用 IP），跟踪只产生 stuck 噪音。
import "./helpers.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { applyMinimal, removeMinimal, isMinimal, readUserConfig, writeUserConfig } from "../src/minimal.js";
import { loadConfig, userConfigPath } from "../src/config.js";
import { targetDomains } from "../src/health.js";

test("minimal: on 收敛 domains(主站+assets,页面完整性),用户其它键原样保留", () => {
  const user = { doh: [{ host: "223.5.5.5" }], schedule: { daemonHealthyMs: 120_000 }, custom: 1 };
  const on = applyMinimal(user);
  assert.equal(isMinimal(on), true);
  assert.deepEqual(on.domains, ["github.com", "github.githubassets.com"],
    "assets 必须带上 —— 主站页面的 CSS/JS 全在它上面,不带必慢");
  assert.equal(on.schedule.daemonHealthyMs, 120_000, "用户其它键保留");
  assert.deepEqual(on.doh, [{ host: "223.5.5.5" }]);
  assert.equal(on.custom, 1);
});

test("targetDomains: 兜底只跟随被跟踪的主域名(minimal 下 raw 的兜底不再进名单)", () => {
  const cfg = { domains: ["github.com"], fallbacks: { "raw.githubusercontent.com": ["fastly.jsdelivr.net"] } };
  assert.deepEqual(targetDomains(cfg), ["github.com"], "raw 不被跟踪,其兜底也不该被跟踪");
  const full = { domains: ["github.com", "raw.githubusercontent.com"], fallbacks: { "raw.githubusercontent.com": ["fastly.jsdelivr.net"] } };
  assert.deepEqual(targetDomains(full), ["github.com", "raw.githubusercontent.com", "fastly.jsdelivr.net"], "默认行为不变");
});

test("minimal: off 删键回落(用户自有键保留),与 lowkey 互不干扰", () => {
  const on = applyMinimal({ doh: [{ host: "223.5.5.5" }], lowkey: { enabled: true } });
  const off = removeMinimal(on);
  assert.equal(isMinimal(off), false);
  assert.equal(off.domains, undefined, "domains 删键回落默认 9 域名");
  assert.equal(off.fallbacks, undefined, "兜底链恢复默认");
  assert.ok(!("minimal" in off));
  assert.equal(isLowkeyCompatible(off), true, "lowkey 标记不受 minimal off 影响");
  function isLowkeyCompatible(u) { return Boolean(u.lowkey && u.lowkey.enabled); }
  assert.equal(removeMinimal(null) && typeof removeMinimal(null), "object", "空输入不抛");
});

test("minimal: 端到端 —— 写盘后 loadConfig/targetDomains 只剩主站两域名", () => {
  const original = readUserConfig();
  try {
    writeUserConfig(applyMinimal(original || {}));
    const cfg = loadConfig();
    assert.deepEqual(cfg.domains, ["github.com", "github.githubassets.com"], "配置热生效");
    assert.deepEqual(targetDomains(cfg), ["github.com", "github.githubassets.com"],
      "orphan 清理以此为据,其余 hosts 条目会被剥掉");
    writeUserConfig(removeMinimal(readUserConfig()));
    const restored = loadConfig();
    assert.ok(restored.domains.length >= 9, "off 后回落默认域名数");
  } finally {
    if (original) { writeUserConfig(original); } else { try { fs.rmSync(userConfigPath(), { force: true }); } catch { /* 忽略 */ } }
  }
});
