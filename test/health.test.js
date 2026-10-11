// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 zmw
// 调度层离线单测：解析/序列化/决策/部分更新/全灭护栏（不联网、不写系统文件）
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseBlock, buildHealthBlock, decide, applyDelta, targetDomains, blockFromProbeResult, shouldKeepOldBlock } from "../src/health.js";

const cfg = {
  domains: ["github.com", "codeload.github.com", "raw.githubusercontent.com"],
  schedule: { absentCooldownHours: 1 },
};

test("parseBlock: 解析 IP 条目与 absent 冷却", () => {
  const content = [
    "# === ghprobe begin ===",
    "# generated 2026-10-11T00:00:00.000Z by ghprobe",
    "20.205.243.166 github.com",
    "# absent raw.githubusercontent.com 2026-10-11T00:00:00.000Z",
    "# === ghprobe end ===",
  ].join("\n");
  const p = parseBlock(content);
  assert.equal(p.entries.get("github.com"), "20.205.243.166");
  assert.equal(p.entries.has("raw.githubusercontent.com"), false);
  assert.equal(p.absent.get("raw.githubusercontent.com"), "2026-10-11T00:00:00.000Z");
});

test("parseBlock: 忽略块外条目", () => {
  const content = "127.0.0.1 localhost\n# === ghprobe begin ===\n1.1.1.1 github.com\n# === ghprobe end ===\n8.8.8.8 google.com\n";
  const p = parseBlock(content);
  assert.equal(p.entries.size, 1);
  assert.equal(p.entries.get("github.com"), "1.1.1.1");
});

test("buildHealthBlock: 序列化可被 parseBlock 无损读回", () => {
  const entries = new Map([["github.com", "20.205.243.166"], ["codeload.github.com", "20.205.243.165"]]);
  const absent = new Map([["raw.githubusercontent.com", "2026-10-11T00:00:00.000Z"]]);
  const p = parseBlock(buildHealthBlock(entries, absent));
  assert.equal(p.entries.get("github.com"), "20.205.243.166");
  assert.equal(p.entries.get("codeload.github.com"), "20.205.243.165");
  assert.equal(p.absent.get("raw.githubusercontent.com"), "2026-10-11T00:00:00.000Z");
});

test("decide: 全健康且无缺失 -> none", () => {
  const singleCfg = { domains: ["github.com"], schedule: { absentCooldownHours: 1 } };
  const current = { entries: new Map([["github.com", "1.1.1.1"]]), absent: new Map() };
  const d = decide([{ domain: "github.com", ok: true }], current, singleCfg);
  assert.equal(d.action, "none");
});

test("decide: 单域名失败 -> full（有健康参照，是 IP 死不是断网）", () => {
  const twoCfg = { domains: ["github.com", "codeload.github.com"], schedule: { absentCooldownHours: 1 } };
  const current = { entries: new Map([["github.com", "1.1.1.1"], ["codeload.github.com", "2.2.2.2"]]), absent: new Map() };
  const d = decide([
    { domain: "github.com", ok: false },
    { domain: "codeload.github.com", ok: true },
  ], current, twoCfg);
  assert.equal(d.action, "full");
  assert.deepEqual(d.domains, ["github.com"]);
});

const fourCfg = {
  domains: ["github.com", "codeload.github.com", "avatars.githubusercontent.com", "objects.githubusercontent.com"],
  schedule: { absentCooldownHours: 1 },
};

test("decide: 全部已写入 IP 失败 -> none（疑似网络故障，避开黑洞窗口）", () => {
  const current = {
    entries: new Map([["github.com", "1.1.1.1"], ["codeload.github.com", "2.2.2.2"], ["avatars.githubusercontent.com", "3.3.3.3"]]),
    absent: new Map(),
  };
  const d = decide([
    { domain: "github.com", ok: false },
    { domain: "codeload.github.com", ok: false },
    { domain: "avatars.githubusercontent.com", ok: false },
  ], current, cfg);
  assert.equal(d.action, "none");
});

// 回归用例：旧判据 `failed.size * 2 > total` 只要「多数失败」就放弃，
// 实测会把「3 条陈旧 + 1 条健康」误判成断网 → 该修的时候不修。
test("decide: 多数失败但仍有健康项 -> full（链路通，是 IP 陈旧，必须重排）", () => {
  const current = {
    entries: new Map([
      ["github.com", "1.1.1.1"],
      ["codeload.github.com", "2.2.2.2"],
      ["avatars.githubusercontent.com", "3.3.3.3"],
      ["objects.githubusercontent.com", "4.4.4.4"],
    ]),
    absent: new Map(),
  };
  const d = decide([
    { domain: "github.com", ok: false },
    { domain: "codeload.github.com", ok: true },
    { domain: "avatars.githubusercontent.com", ok: false },
    { domain: "objects.githubusercontent.com", ok: false },
  ], current, fourCfg);
  assert.equal(d.action, "full");
  assert.deepEqual(
    [...d.domains].sort(),
    ["avatars.githubusercontent.com", "github.com", "objects.githubusercontent.com"],
  );
});

test("decide: 2 条全失败 -> none（≥2 条全灭才判网络故障）", () => {
  const twoCfg = { domains: ["github.com", "codeload.github.com"], schedule: { absentCooldownHours: 1 } };
  const current = { entries: new Map([["github.com", "1.1.1.1"], ["codeload.github.com", "2.2.2.2"]]), absent: new Map() };
  const d = decide([
    { domain: "github.com", ok: false },
    { domain: "codeload.github.com", ok: false },
  ], current, twoCfg);
  assert.equal(d.action, "none");
});

test("decide: 只有 1 条且失败 -> full（无横向参照，倾向重排）", () => {
  const oneCfg = { domains: ["github.com"], schedule: { absentCooldownHours: 1 } };
  const current = { entries: new Map([["github.com", "1.1.1.1"]]), absent: new Map() };
  const d = decide([{ domain: "github.com", ok: false }], current, oneCfg);
  assert.equal(d.action, "full");
});

test("decide: 缺失域名非冷却 -> full", () => {
  const current = { entries: new Map([["github.com", "1.1.1.1"]]), absent: new Map() };
  const d = decide([{ domain: "github.com", ok: true }], current, cfg);
  assert.equal(d.action, "full");
  assert.deepEqual(d.domains, ["codeload.github.com", "raw.githubusercontent.com"]);
});

test("decide: 缺失域名冷却内 -> 不纳入", () => {
  const now = new Date().toISOString();
  const current = {
    entries: new Map([["github.com", "1.1.1.1"]]),
    absent: new Map([["raw.githubusercontent.com", now]]),
  };
  const d = decide([{ domain: "github.com", ok: true }], current, cfg);
  // codeload 仍缺失（非冷却），raw 在冷却内
  assert.deepEqual(d.domains, ["codeload.github.com"]);
});

test("applyDelta: 部分更新只改诊断域名，健康域名保持粘性", () => {
  const current = {
    entries: new Map([["github.com", "旧ip"], ["codeload.github.com", "旧codeload"]]),
    absent: new Map(),
  };
  const ranked = new Map([
    ["github.com", [{ ip: "新ip" }]],
    ["codeload.github.com", [{ ip: "新codeload" }]],
  ]);
  // 只诊断 github.com
  const d = applyDelta(current, ranked, new Map(), ["github.com"], cfg);
  assert.equal(d.entries.get("github.com"), "新ip");
  assert.equal(d.entries.get("codeload.github.com"), "旧codeload"); // 未诊断，不动
  assert.deepEqual(d.changed, ["github.com"]);
});

test("applyDelta: 全灭护栏——失败域名无新活 IP 时保留旧 IP", () => {
  const current = {
    entries: new Map([["github.com", "旧ip"]]),
    absent: new Map(),
  };
  const ranked = new Map([["github.com", []]]); // 全灭
  const d = applyDelta(current, ranked, new Map(), ["github.com"], cfg);
  assert.equal(d.entries.get("github.com"), "旧ip"); // 保留，不写空
  assert.equal(d.changed.length, 0);
});

test("applyDelta: 缺失域名全灭 -> 记 absent 冷却", () => {
  const current = { entries: new Map(), absent: new Map() };
  const ranked = new Map([["raw.githubusercontent.com", []]]);
  const d = applyDelta(current, ranked, new Map(), ["raw.githubusercontent.com"], cfg);
  assert.equal(d.entries.has("raw.githubusercontent.com"), false);
  assert.ok(d.absent.has("raw.githubusercontent.com"));
});

test("applyDelta: 缺失域名探到活 IP -> 补写并清除 absent", () => {
  const current = {
    entries: new Map(),
    absent: new Map([["raw.githubusercontent.com", "旧ts"]]),
  };
  const ranked = new Map([["raw.githubusercontent.com", [{ ip: "9.9.9.9" }]]]);
  const d = applyDelta(current, ranked, new Map(), ["raw.githubusercontent.com"], cfg);
  assert.equal(d.entries.get("raw.githubusercontent.com"), "9.9.9.9");
  assert.equal(d.absent.has("raw.githubusercontent.com"), false);
  assert.deepEqual(d.changed, ["raw.githubusercontent.com"]);
});

const fbCfg = {
  domains: ["github.com", "raw.githubusercontent.com"],
  fallbacks: { "raw.githubusercontent.com": ["cdn.jsdelivr.net"] },
  schedule: { absentCooldownHours: 1 },
};

test("targetDomains: 合并主域名与兜底域名", () => {
  assert.deepEqual(targetDomains(fbCfg), ["github.com", "raw.githubusercontent.com", "cdn.jsdelivr.net"]);
});

test("decide: 兜底域名缺失也触发 full（不再漏检）", () => {
  const current = {
    entries: new Map([["github.com", "1.1.1.1"]]),
    absent: new Map(),
  };
  const d = decide([{ domain: "github.com", ok: true }], current, fbCfg);
  assert.equal(d.action, "full");
  // raw 与兜底 jsdelivr 都缺失，都应进诊断集
  assert.deepEqual(d.domains, ["raw.githubusercontent.com", "cdn.jsdelivr.net"]);
});

test("applyDelta: orphan 清理——config 已移除的域名从 entries 删除", () => {
  const current = {
    entries: new Map([["github.com", "1.1.1.1"], ["old.example.com", "9.9.9.9"]]),
    absent: new Map(),
  };
  const ranked = new Map([["github.com", [{ ip: "1.1.1.1" }]]]);
  const d = applyDelta(current, ranked, new Map(), ["old.example.com"], fbCfg);
  assert.equal(d.entries.has("old.example.com"), false);
  assert.deepEqual(d.changed, ["old.example.com"]);
});

test("applyDelta: 兜底域名探到活 IP -> 补写进 entries", () => {
  const current = { entries: new Map([["github.com", "1.1.1.1"]]), absent: new Map() };
  const extra = new Map([["cdn.jsdelivr.net", [{ ip: "104.16.0.1" }]]]);
  const d = applyDelta(current, new Map(), extra, ["cdn.jsdelivr.net"], fbCfg);
  assert.equal(d.entries.get("cdn.jsdelivr.net"), "104.16.0.1");
  assert.deepEqual(d.changed, ["cdn.jsdelivr.net"]);
});

// ── 两条写入路径块格式统一 + 全灭护栏 ────────────────────────────────
test("blockFromProbeResult: 无活 IP 的目标域名记入 # absent 冷却（与 health 块同构）", () => {
  const p = parseBlock(blockFromProbeResult(fbCfg, {
    ranked: new Map([["github.com", [{ ip: "20.205.243.166" }]], ["raw.githubusercontent.com", []]]),
    extra: new Map([["cdn.jsdelivr.net", [{ ip: "104.16.0.1" }]]]),
  }));
  assert.equal(p.entries.get("github.com"), "20.205.243.166");
  assert.equal(p.entries.get("cdn.jsdelivr.net"), "104.16.0.1");
  assert.equal(p.entries.has("raw.githubusercontent.com"), false);
  assert.ok(p.absent.has("raw.githubusercontent.com"), "无活 IP 的目标域名应记入 absent 冷却，否则下次 health 白跑全量");
});

test("shouldKeepOldBlock: 新块全灭而旧块有条目 -> 拒绝写入（全灭护栏）", () => {
  const oldContent = buildHealthBlock(new Map([["github.com", "1.1.1.1"]]), new Map());
  const emptyBlock = buildHealthBlock(new Map(), new Map([["github.com", "2026-10-11T00:00:00.000Z"]]));
  assert.equal(shouldKeepOldBlock(oldContent, emptyBlock), true);
});

test("shouldKeepOldBlock: 旧块本来就没有条目 -> 允许写入", () => {
  const emptyBlock = buildHealthBlock(new Map(), new Map([["github.com", "2026-10-11T00:00:00.000Z"]]));
  assert.equal(shouldKeepOldBlock("127.0.0.1 localhost\n", emptyBlock), false);
});

test("shouldKeepOldBlock: 新块有活 IP -> 允许写入", () => {
  const oldContent = buildHealthBlock(new Map([["github.com", "1.1.1.1"]]), new Map());
  const newBlock = buildHealthBlock(new Map([["github.com", "2.2.2.2"]]), new Map());
  assert.equal(shouldKeepOldBlock(oldContent, newBlock), false);
});