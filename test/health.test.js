// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 zmw
// 调度层离线单测：解析/序列化/决策/部分更新/全灭护栏（不联网、不写系统文件）
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseBlock, buildHealthBlock, decide, applyDelta, targetDomains, blockFromProbeResult, shouldKeepOldBlock, blockedDomainsFromRaw } from "../src/health.js";

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

// stuck：被诊断了、本轮却一个活 IP 都没找到、只能保留旧值的域名。
// 黑洞窗口里必然出现，必须显式报出来 —— 否则日志只写「无变化」，用户会以为工具没干活。
test("applyDelta: stuck——诊断过但无活 IP，保留旧值并显式列出", () => {
  const current = {
    entries: new Map([["github.com", "旧ip"], ["codeload.github.com", "旧codeload"]]),
    absent: new Map(),
  };
  const ranked = new Map([["github.com", []], ["codeload.github.com", [{ ip: "新codeload" }]]]);
  const d = applyDelta(current, ranked, new Map(), ["github.com"], cfg);
  assert.equal(d.entries.get("github.com"), "旧ip", "全灭护栏：不写空");
  assert.deepEqual(d.stuck, ["github.com"]);
  assert.deepEqual(d.changed, []);
});

test("applyDelta: orphan 被删掉，不计入 stuck（它本来就是要清理的）", () => {
  const current = {
    entries: new Map([["github.com", "1.1.1.1"], ["old.example.com", "9.9.9.9"]]),
    absent: new Map(),
  };
  const ranked = new Map([["github.com", [{ ip: "1.1.1.1" }]]]);
  const d = applyDelta(current, ranked, new Map(), ["old.example.com"], cfg);
  assert.equal(d.entries.has("old.example.com"), false);
  assert.deepEqual(d.stuck, [], "orphan 是清理对象，不是「没探到活 IP」");
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

// ── 同名多条目（客户端 fallback）────────────────────────────────────
// 2026-10-11 实测：Windows hosts 同名多条会被解析器**全部返回**（保持顺序），
// curl / 浏览器会逐个尝试 → 首条抖动失效时可自动 fallback。以下用例锁住这个行为。
test("parseBlock: 同名多条 -> 第一条为主 IP，其余按顺序进 extras", () => {
  const content = [
    "# === ghprobe begin ===",
    "20.205.243.166 github.com",
    "20.200.245.247 github.com",
    "140.82.116.3 github.com",
    "# === ghprobe end ===",
  ].join("\n");
  const p = parseBlock(content);
  assert.equal(p.entries.get("github.com"), "20.205.243.166");
  assert.deepEqual(p.extras.get("github.com"), ["20.200.245.247", "140.82.116.3"]);
});

test("parseBlock: 重复 IP 不重复计入 extras", () => {
  const content = "# === ghprobe begin ===\n1.1.1.1 a.com\n1.1.1.1 a.com\n2.2.2.2 a.com\n# === ghprobe end ===";
  const p = parseBlock(content);
  assert.equal(p.entries.get("a.com"), "1.1.1.1");
  assert.deepEqual(p.extras.get("a.com"), ["2.2.2.2"]);
});

test("buildHealthBlock: 同名多条（含 extras）无损往返", () => {
  const entries = new Map([["github.com", "20.205.243.166"]]);
  const extras = new Map([["github.com", ["20.200.245.247"]]]);
  const p = parseBlock(buildHealthBlock(entries, new Map(), extras));
  assert.equal(p.entries.get("github.com"), "20.205.243.166");
  assert.deepEqual(p.extras.get("github.com"), ["20.200.245.247"]);
});

test("buildHealthBlock: 备选与主 IP 相同则不重复写行", () => {
  const entries = new Map([["github.com", "1.1.1.1"]]);
  const extras = new Map([["github.com", ["1.1.1.1"]]]);
  const lines = buildHealthBlock(entries, new Map(), extras).split("\n").filter((l) => l.endsWith(" github.com"));
  assert.equal(lines.length, 1);
});

test("applyDelta: 每域名写 maxEntriesPerDomain 条（主 IP + 备选）", () => {
  const multiCfg = { domains: ["github.com"], schedule: { absentCooldownHours: 1 }, hosts: { maxEntriesPerDomain: 2 } };
  const current = { entries: new Map([["github.com", "1.1.1.1"]]), extras: new Map(), absent: new Map() };
  const ranked = new Map([["github.com", [{ ip: "1.1.1.1" }, { ip: "2.2.2.2" }, { ip: "3.3.3.3" }]]]);
  const d = applyDelta(current, ranked, new Map(), ["github.com"], multiCfg);
  assert.equal(d.entries.get("github.com"), "1.1.1.1");
  assert.deepEqual(d.extras.get("github.com"), ["2.2.2.2"], "maxPer=2 -> 主 IP + 1 个备选");
});

test("applyDelta: maxEntriesPerDomain=1 -> 退回单条（无 extras）", () => {
  const oneCfg = { domains: ["github.com"], schedule: { absentCooldownHours: 1 }, hosts: { maxEntriesPerDomain: 1 } };
  const current = { entries: new Map([["github.com", "1.1.1.1"]]), extras: new Map(), absent: new Map() };
  const ranked = new Map([["github.com", [{ ip: "1.1.1.1" }, { ip: "2.2.2.2" }]]]);
  const d = applyDelta(current, ranked, new Map(), ["github.com"], oneCfg);
  assert.equal(d.extras.has("github.com"), false);
});

test("applyDelta: orphan 域名的主 IP 与备选一起清掉", () => {
  const cfg2 = { domains: ["github.com"], schedule: { absentCooldownHours: 1 }, hosts: { maxEntriesPerDomain: 2 } };
  const current = {
    entries: new Map([["old.example.com", "1.1.1.1"]]),
    extras: new Map([["old.example.com", ["2.2.2.2"]]]),
    absent: new Map(),
  };
  const d = applyDelta(current, new Map(), new Map(), ["old.example.com"], cfg2);
  assert.equal(d.entries.has("old.example.com"), false);
  assert.equal(d.extras.has("old.example.com"), false, "orphan 的备选也要清，否则会留孤儿行");
});

test("blockFromProbeResult: 每域名写多条（主 IP + 备选）", () => {
  const multiCfg = { domains: ["github.com"], fallbacks: {}, schedule: { absentCooldownHours: 1 }, hosts: { maxEntriesPerDomain: 2 } };
  const block = blockFromProbeResult(multiCfg, {
    ranked: new Map([["github.com", [{ ip: "20.205.243.166" }, { ip: "20.200.245.247" }]]]),
    extra: new Map(),
  });
  const p = parseBlock(block);
  assert.equal(p.entries.get("github.com"), "20.205.243.166");
  assert.deepEqual(p.extras.get("github.com"), ["20.200.245.247"]);
});

// ============================================================================
// 2026-10-11 新增：针对线上实测故障（主 IP 变假活、备选是好的却没人管）
// 旧逻辑只探主条目，于是「主挂了 + 备选活着」被当成「域名挂了」-> 直接重排 ->
// 撞上 IP 抖动窗口 -> 换了个更差的，用户反而断网。备选不该只写不读。
// ============================================================================

// 只用被测域名建 cfg：否则 cfg.domains 里没写进 entries 的域名会被当成「缺失」纳入重排，干扰断言
const ghOnlyCfg = { domains: ["github.com"], schedule: { absentCooldownHours: 1 } };
const ghCoCfg = { domains: ["github.com", "codeload.github.com"], schedule: { absentCooldownHours: 1 } };

test("decide: 主 IP 挂、备选活着 -> 提上备选，不重排", () => {
  const current = {
    entries: new Map([["github.com", "1.1.1.1"]]),
    extras: new Map([["github.com", ["2.2.2.2"]]]),
    absent: new Map(),
  };
  const d = decide([
    { domain: "github.com", ip: "1.1.1.1", ok: false, role: "main" },
    { domain: "github.com", ip: "2.2.2.2", ok: true, role: "alt" },
  ], current, ghOnlyCfg);
  assert.equal(d.action, "full");
  assert.deepEqual(d.domains, [], "有活着的备选就不该重排");
  assert.equal(d.promote.get("github.com"), "2.2.2.2");
});

test("decide: 主 IP 与备选全挂 -> 才纳入重排", () => {
  const current = {
    entries: new Map([["github.com", "1.1.1.1"], ["codeload.github.com", "3.3.3.3"]]),
    extras: new Map([["github.com", ["2.2.2.2"]]]),
    absent: new Map(),
  };
  const d = decide([
    { domain: "github.com", ip: "1.1.1.1", ok: false, role: "main" },
    { domain: "github.com", ip: "2.2.2.2", ok: false, role: "alt" },
    { domain: "codeload.github.com", ip: "3.3.3.3", ok: true, role: "main" },
  ], current, ghCoCfg);
  assert.equal(d.action, "full");
  assert.deepEqual(d.domains, ["github.com"]);
  assert.equal(d.promote.size, 0);
});

test("decide: 主全挂但备选都活 -> 不误判成网络故障", () => {
  // 横向判据按「域名」而非「条目」计数：域名还有活着的条目就不算全灭
  const current = {
    entries: new Map([["github.com", "1.1.1.1"], ["codeload.github.com", "3.3.3.3"]]),
    extras: new Map([["github.com", ["2.2.2.2"]], ["codeload.github.com", ["4.4.4.4"]]]),
    absent: new Map(),
  };
  const d = decide([
    { domain: "github.com", ip: "1.1.1.1", ok: false, role: "main" },
    { domain: "github.com", ip: "2.2.2.2", ok: true, role: "alt" },
    { domain: "codeload.github.com", ip: "3.3.3.3", ok: false, role: "main" },
    { domain: "codeload.github.com", ip: "4.4.4.4", ok: true, role: "alt" },
  ], current, ghCoCfg);
  assert.equal(d.action, "full");
  assert.deepEqual(d.domains, []);
  assert.deepEqual([...d.promote.keys()].sort(), ["codeload.github.com", "github.com"]);
});

test("applyDelta: promote 把备选提为主 IP，旧主降为备选（留着当兜底）", () => {
  const current = {
    entries: new Map([["github.com", "1.1.1.1"]]),
    extras: new Map([["github.com", ["2.2.2.2"]]]),
    absent: new Map(),
  };
  const d = applyDelta(current, new Map(), new Map(), [], cfg, new Map([["github.com", "2.2.2.2"]]));
  assert.equal(d.entries.get("github.com"), "2.2.2.2");
  assert.deepEqual(d.extras.get("github.com"), ["1.1.1.1"]);
  assert.deepEqual(d.changed, ["github.com"]);
});

test("applyDelta: 本轮活 IP 不足时不删原有备选（保住 fallback）", () => {
  const current = {
    entries: new Map([["github.com", "1.1.1.1"]]),
    extras: new Map([["github.com", ["9.9.9.9"]]]),
    absent: new Map(),
  };
  // 抖动窗口里只探到 1 个活 IP；旧写法 `alt.length ? set : delete` 会把备选删掉
  const ranked = new Map([["github.com", [{ ip: "1.1.1.1" }]]]);
  const d = applyDelta(current, ranked, new Map(), ["github.com"], cfg);
  assert.equal(d.entries.get("github.com"), "1.1.1.1");
  assert.deepEqual(d.extras.get("github.com"), ["9.9.9.9"]);
});

test("applyDelta: 探到新备选时排在前，旧备选在后，按 maxEntriesPerDomain 截断", () => {
  const current = {
    entries: new Map([["github.com", "1.1.1.1"]]),
    extras: new Map([["github.com", ["9.9.9.9"]]]),
    absent: new Map(),
  };
  const ranked = new Map([["github.com", [{ ip: "1.1.1.1" }, { ip: "5.5.5.5" }]]]);
  const d = applyDelta(current, ranked, new Map(), ["github.com"], cfg);
  assert.deepEqual(d.extras.get("github.com"), ["5.5.5.5"]);
});
// ============================================================================
// 2026-10-11 新增：`# blocked`（探测不可判）与 `# absent`（确实无可用 IP）分开
// 动机：浏览器能打开 raw.githubusercontent.com，但 Node/curl 被指纹重置 ——
//       工具把后者写成 `# absent` 会让日志和 hosts 都误导用户。
// ============================================================================

test("parseBlock: 解析 # blocked 注释（与 # absent 分开）", () => {
  const content = [
    "# === ghprobe begin ===",
    "20.205.243.166 github.com",
    "# absent codeload.github.com 2026-10-11T00:00:00.000Z",
    "# blocked raw.githubusercontent.com 2026-10-11T00:00:00.000Z",
    "# === ghprobe end ===",
  ].join("\n");
  const p = parseBlock(content);
  assert.equal(p.absent.get("codeload.github.com"), "2026-10-11T00:00:00.000Z");
  assert.equal(p.blocked.get("raw.githubusercontent.com"), "2026-10-11T00:00:00.000Z");
  assert.equal(p.absent.has("raw.githubusercontent.com"), false);
});

test("buildHealthBlock: 写出 # blocked 且与 # absent 不混", () => {
  const block = buildHealthBlock(
    new Map([["github.com", "1.1.1.1"]]),
    new Map([["codeload.github.com", "2026-10-11T00:00:00.000Z"]]),
    new Map(),
    new Map([["raw.githubusercontent.com", "2026-10-11T00:00:00.000Z"]]),
  );
  const p = parseBlock(block);
  assert.equal(p.blocked.get("raw.githubusercontent.com"), "2026-10-11T00:00:00.000Z");
  assert.equal(p.absent.get("codeload.github.com"), "2026-10-11T00:00:00.000Z");
});

test("blockedDomainsFromRaw: 全部候选都在 TLS 阶段被重置 -> 判为指纹阻断", () => {
  const raw = [
    { domain: "raw.githubusercontent.com", ip: "1.1.1.1", ok: false, stage: "tls", err: "ECONNRESET", tlsBlocked: true },
    { domain: "raw.githubusercontent.com", ip: "2.2.2.2", ok: false, stage: "tls", err: "timeout", tlsBlocked: true },
    { domain: "github.com", ip: "3.3.3.3", ok: true },
  ];
  const b = blockedDomainsFromRaw(raw);
  assert.equal(b.has("raw.githubusercontent.com"), true);
  assert.equal(b.has("github.com"), false, "有活 IP 的域名不算阻断");
});

test("blockedDomainsFromRaw: 混合失败（一半黑洞一半 reset）不算阻断", () => {
  const raw = [
    { domain: "x.com", ip: "1.1.1.1", ok: false, stage: "tls", err: "ECONNRESET", tlsBlocked: true },
    { domain: "x.com", ip: "2.2.2.2", ok: false, stage: "tcp", err: "timeout", tlsBlocked: false },
  ];
  assert.equal(blockedDomainsFromRaw(raw).has("x.com"), false);
});

test("applyDelta: 指纹阻断的域名写 blocked 而不是 absent", () => {
  const current = { entries: new Map(), extras: new Map(), absent: new Map(), blocked: new Map() };
  const d = applyDelta(current, new Map(), new Map(), ["raw.githubusercontent.com"], cfg, new Map(),
    new Set(["raw.githubusercontent.com"]));
  assert.equal(d.blocked.has("raw.githubusercontent.com"), true);
  assert.equal(d.absent.has("raw.githubusercontent.com"), false);
  assert.deepEqual(d.sniBlocked, ["raw.githubusercontent.com"]);
});

test("applyDelta: 普通失败仍写 absent（不能把两类混为一谈）", () => {
  const current = { entries: new Map(), extras: new Map(), absent: new Map(), blocked: new Map() };
  const d = applyDelta(current, new Map(), new Map(), ["codeload.github.com"], cfg, new Map(), new Set());
  assert.equal(d.absent.has("codeload.github.com"), true);
  assert.equal(d.blocked.has("codeload.github.com"), false);
});

test("applyDelta: 域名重新探到活 IP -> 清掉 blocked", () => {
  const current = {
    entries: new Map(), extras: new Map(), absent: new Map(),
    blocked: new Map([["raw.githubusercontent.com", "2026-10-11T00:00:00.000Z"]]),
  };
  const ranked = new Map([["raw.githubusercontent.com", [{ ip: "9.9.9.9" }]]]);
  const d = applyDelta(current, ranked, new Map(), ["raw.githubusercontent.com"], cfg, new Map(), new Set());
  assert.equal(d.entries.get("raw.githubusercontent.com"), "9.9.9.9");
  assert.equal(d.blocked.has("raw.githubusercontent.com"), false);
});

test("decide: blocked 冷却内的域名不再纳入重排（避免每分钟空探）", () => {
  const now = new Date().toISOString();
  const current = {
    entries: new Map([["github.com", "1.1.1.1"], ["codeload.github.com", "2.2.2.2"]]),
    extras: new Map(), absent: new Map(),
    blocked: new Map([["raw.githubusercontent.com", now]]),
  };
  const d = decide([
    { domain: "github.com", ok: true },
    { domain: "codeload.github.com", ok: true },
  ], current, cfg);
  // raw 在 blocked 冷却内 -> 不当作「缺失」，否则每分钟都会为它白跑一次全量探测
  assert.equal(d.action, "none");
});
