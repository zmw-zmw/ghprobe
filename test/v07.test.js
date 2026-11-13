// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 zmw
// v0.1.6：用户运营三件套 —— 日志滚动 / off-on 暂停 / 更新检查。
// 全部注入式：不碰真实 %LOCALAPPDATA%，不发真实网络请求。
import "./helpers.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  rotateLogIfNeeded, LOG_MAX_BYTES, LOG_KEEP_BYTES,
  pausedFlagPath, isPaused, setPaused,
  buildPauseTaskScript, buildStartTaskScript,
} from "../src/hosts.js";
import { isNewer, checkUpdate, maybeNotifyUpdate, updateCheckPath } from "../src/updates.js";
import { daemonCycle } from "../src/daemon.js";
import { buildStatusReport } from "../src/status.js";

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "ghprobe-v07-"));
}

// ---------- 日志滚动 ----------

test("rotateLogIfNeeded: 小于阈值不动", () => {
  const dir = tmpDir();
  const f = path.join(dir, "log.txt");
  fs.writeFileSync(f, "line-1\nline-2\n", "utf8");
  assert.equal(rotateLogIfNeeded(f, { max: 4096, keep: 2048 }), false);
  assert.equal(fs.readFileSync(f, "utf8"), "line-1\nline-2\n");
});

test("rotateLogIfNeeded: 文件不存在返回 false 不抛", () => {
  const dir = tmpDir();
  assert.equal(rotateLogIfNeeded(path.join(dir, "nope.txt")), false);
});

test("rotateLogIfNeeded: 超限截断保留尾部、掐掉半行、不超 keep 上限", () => {
  const dir = tmpDir();
  const f = path.join(dir, "log.txt");
  // ~100 行 x ~110 字节 ≈ 11KB；max=4KB keep=2KB
  const big = Array.from({ length: 100 }, (_, i) => `2026-11-13T0${i % 10}:00:00 line-${i} ${"x".repeat(90)}`).join("\n") + "\n";
  fs.writeFileSync(f, big, "utf8");
  assert.equal(rotateLogIfNeeded(f, { max: 4096, keep: 2048 }), true);
  const st = fs.statSync(f);
  assert.ok(st.size <= 2048 + 200, `截断后应≈keep，实际 ${st.size}`);
  const after = fs.readFileSync(f, "utf8");
  assert.ok(after.includes("line-99"), "最后一行必须保留");
  assert.ok(!after.includes("line-0 "), "开头内容应被截掉");
  assert.ok(!/^[^\r\n]*line-\d+/.test(after.split("\n")[0].replace(/^\ufeff/, "").replace(/^2026\S* /, "")) || after.split("\n")[0].includes("T0"), "第一行应是完整行(时间戳开头)");
  // 再滚一次：小于阈值，幂等不动
  assert.equal(rotateLogIfNeeded(f, { max: 4096, keep: 2048 }), false);
});

test("rotateLogIfNeeded: 默认阈值为 2MB/256KB", () => {
  assert.equal(LOG_MAX_BYTES, 2 * 1024 * 1024);
  assert.equal(LOG_KEEP_BYTES, 256 * 1024);
});

// ---------- off / on 暂停标记 ----------

test("setPaused/isPaused: 独立目录可注入，on/off 幂等", () => {
  const dir = tmpDir();
  const f = pausedFlagPath(dir);
  assert.equal(isPaused(f), false);
  assert.equal(setPaused(true, f), true);
  assert.equal(isPaused(f), true, "off 后应读到暂停");
  setPaused(true, f); // 重复 off 不炸
  assert.equal(isPaused(f), true);
  assert.equal(setPaused(false, f), true);
  assert.equal(isPaused(f), false, "on 后应恢复");
  setPaused(false, f); // 重复 on 不炸
  assert.equal(isPaused(f), false);
});

test("setPaused: 标记文件落在给定目录且可写内容是时间戳", () => {
  const dir = tmpDir();
  const f = pausedFlagPath(dir);
  setPaused(true, f);
  const content = fs.readFileSync(f, "utf8");
  assert.ok(!Number.isNaN(new Date(content.trim()).getTime()), "标记内容应是可解析时间");
});

// ---------- 任务暂停/恢复提权脚本 ----------

test("buildPauseTaskScript: off=Disable / on=Enable，含幂等守卫与 Stop 纪律", () => {
  const off = buildPauseTaskScript(true);
  const on = buildPauseTaskScript(false);
  assert.ok(off.includes("Disable-ScheduledTask"), "off 应 Disable");
  assert.ok(on.includes("Enable-ScheduledTask"), "on 应 Enable");
  assert.ok(!on.includes("Disable-ScheduledTask") && !off.includes("Enable-ScheduledTask"), "两个方向不串");
  for (const s of [off, on]) {
    assert.ok(s.includes("Get-ScheduledTask -TaskName 'ghprobe' -ErrorAction SilentlyContinue"), "任务不存在要幂等跳过");
    assert.ok(s.includes("-ErrorAction Stop"), "动作必须 Stop（非终止错误会伪装成 exit 0）");
    assert.ok(s.includes("exit 0") && s.includes("exit 1"), "退出码要分得清成败");
  }
});

test("buildStartTaskScript: Start-ScheduledTask + 幂等守卫", () => {
  const s = buildStartTaskScript();
  assert.ok(s.includes("Start-ScheduledTask -TaskName 'ghprobe' -ErrorAction Stop"));
  assert.ok(s.includes("Get-ScheduledTask -TaskName 'ghprobe' -ErrorAction SilentlyContinue"));
});

// ---------- daemon 暂停门控 ----------

test("daemonCycle: 暂停时直接 skip，不探测不更新池", async () => {
  let probed = false;
  const r = await daemonCycle({}, () => {}, {
    isPaused: () => true,
    hasNetwork: async () => { probed = true; return true; },
  });
  assert.equal(r.action, "skip");
  assert.ok(/暂停/.test(r.reason));
  assert.equal(probed, false, "暂停时连网络检查都不该发");
});

test("daemonCycle: 未暂停时行为不变（走网络检查）", async () => {
  const r = await daemonCycle({}, () => {}, {
    isPaused: () => false,
    hasNetwork: async () => false, // 断网分支
  });
  assert.equal(r.offline, true);
  assert.equal(r.action, "skip");
});

// ---------- status 暂停行 ----------

test("buildStatusReport: 暂停时第一行给恢复指引，不误导用户重装", () => {
  const lines = buildStatusReport({
    hostsContent: "",
    cfg: { domains: ["github.com"], fallbacks: {} },
    logTail: [],
    daemon: null,
    task: null,
    paused: true,
  });
  assert.ok(/已暂停/.test(lines[0]) && /ghprobe on/.test(lines[0]), `首行应为暂停提示，实际: ${lines[0]}`);
  assert.ok(!lines.some((l) => /先跑 ghprobe install/.test(l) && l.includes("hosts：")), "暂停时不应出现『先跑 install』误导文案");
});

test("buildStatusReport: 未暂停时无暂停行", () => {
  const lines = buildStatusReport({
    hostsContent: "",
    cfg: { domains: [], fallbacks: {} },
    logTail: [],
    daemon: null,
    task: null,
    paused: false,
  });
  assert.ok(!lines.some((l) => /已暂停/.test(l)));
});

// ---------- 更新检查 ----------

test("isNewer: 语义化比较", () => {
  assert.equal(isNewer("0.1.6", "0.1.5"), true);
  assert.equal(isNewer("0.2.0", "0.1.9"), true);
  assert.equal(isNewer("1.0.0", "0.9.9"), true);
  assert.equal(isNewer("0.1.5", "0.1.5"), false, "相等不提示");
  assert.equal(isNewer("0.1.4", "0.1.5"), false);
  assert.equal(isNewer("v0.1.6", "0.1.5"), true, "容忍 v 前缀");
  assert.equal(isNewer("0.1.6-beta.1", "0.1.5"), false, "prerelease 宁可不提示");
  assert.equal(isNewer("", "0.1.5"), false);
  assert.equal(isNewer("abc", "0.1.5"), false);
  assert.equal(isNewer("0.1.6", ""), false);
});

test("checkUpdate: 24h 内缓存直接命中，不发请求", async () => {
  const dir = tmpDir();
  const cachePath = path.join(dir, "update.check.json");
  const now = 1_700_000_000_000;
  fs.writeFileSync(cachePath, JSON.stringify({ at: now - 1000, latest: "9.9.9" }));
  let fetched = false;
  const r = await checkUpdate({
    fetchImpl: async () => { fetched = true; throw new Error("should not fetch"); },
    now,
    cachePath,
  });
  assert.equal(r.latest, "9.9.9");
  assert.equal(r.cached, true);
  assert.equal(fetched, false);
});

test("checkUpdate: 缓存过期拉新并写回", async () => {
  const dir = tmpDir();
  const cachePath = path.join(dir, "update.check.json");
  fs.writeFileSync(cachePath, JSON.stringify({ at: 0, latest: "0.1.0" }));
  const now = 1_700_000_000_000;
  const r = await checkUpdate({
    fetchImpl: async (url) => {
      assert.ok(/registry\.(npmmirror|npmjs)\.com/.test(url), `应查 npm registry，实际 ${url}`);
      return { ok: true, json: async () => ({ version: "0.1.6" }) };
    },
    now,
    cachePath,
  });
  assert.equal(r.latest, "0.1.6");
  assert.equal(r.cached, false);
  const cache = JSON.parse(fs.readFileSync(cachePath, "utf8"));
  assert.equal(cache.latest, "0.1.6");
  assert.equal(cache.at, now);
});

test("checkUpdate: 拉取全败返回 null 且不写缓存", async () => {
  const dir = tmpDir();
  const cachePath = path.join(dir, "update.check.json");
  const r = await checkUpdate({
    fetchImpl: async () => { throw new Error("network down"); },
    now: 1_700_000_000_000,
    cachePath,
  });
  assert.equal(r.latest, null);
  assert.equal(fs.existsSync(cachePath), false, "失败不写缓存，下一轮命令还能重试");
});

test("checkUpdate: 官方源兜底（镜像返回不 ok 时试 npmjs）", async () => {
  const dir = tmpDir();
  const urls = [];
  const r = await checkUpdate({
    fetchImpl: async (url) => {
      urls.push(url);
      if (/npmmirror/.test(url)) { return { ok: false }; }
      return { ok: true, json: async () => ({ version: "0.2.0" }) };
    },
    now: 1_700_000_000_000,
    cachePath: path.join(dir, "u.json"),
  });
  assert.equal(r.latest, "0.2.0");
  assert.equal(urls.length, 2);
});

test("maybeNotifyUpdate: 有新版打印一行、无新版静默、失败静默", async () => {
  const dir = tmpDir();
  const cachePath = path.join(dir, "u.json");
  const out = [];
  const log = (m) => out.push(m);
  await maybeNotifyUpdate("0.1.5", log, {
    fetchImpl: async () => ({ ok: true, json: async () => ({ version: "0.1.6" }) }),
    cachePath,
  });
  assert.equal(out.length, 1);
  assert.ok(/0\.1\.6/.test(out[0]) && /npm i -g ghprobe/.test(out[0]), `提示应含新版号与升级命令，实际: ${out[0]}`);

  out.length = 0;
  await maybeNotifyUpdate("0.1.6", log, {
    fetchImpl: async () => ({ ok: true, json: async () => ({ version: "0.1.6" }) }),
    cachePath: path.join(tmpDir(), "x.json"),
  });
  assert.equal(out.length, 0, "同版本不提示");

  out.length = 0;
  await maybeNotifyUpdate("0.1.5", log, {
    fetchImpl: async () => { throw new Error("down"); },
    cachePath: path.join(tmpDir(), "x.json"),
  });
  assert.equal(out.length, 0, "检查失败必须静默");
});

test("updateCheckPath: 默认落在用户数据目录", () => {
  const p = updateCheckPath("/tmp/x");
  assert.equal(p, path.join("/tmp/x", "update.check.json"));
  assert.ok(updateCheckPath().endsWith(path.join("ghprobe", "update.check.json")) || updateCheckPath().includes("ghprobe"));
});
