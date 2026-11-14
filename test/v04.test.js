// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 zmw
// 0.4.0 新逻辑单测：status 速查报告 / meta 拉取自救(健康条目当种子)
import "./helpers.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildStatusReport } from "../src/status.js";
import { seedIps } from "../src/pool.js";
import { sigFor, checkHttpResponse } from "../src/prober.js";

const CFG = {
  domains: ["github.com", "api.github.com"],
  fallbacks: { "raw.githubusercontent.com": ["cdn.jsdelivr.net"] },
  fallbackSigs: {},
  hosts: { maxEntriesPerDomain: 2 },
};

const HOSTS_BLOCK = `# === ghprobe begin ===
# generated 2026-10-31T00:00:00.000Z by ghprobe
20.200.245.247 github.com
20.205.243.166 github.com
20.205.243.168 api.github.com
# absent cdn.jsdelivr.net 2026-10-30T17:39:09.989Z
# blocked raw.githubusercontent.com 2026-10-30T16:50:01.529Z
# === ghprobe end ===
`;

test("buildStatusReport：列出主备条目、缺失/冷却标记与生成时间", () => {
  const lines = buildStatusReport({
    hostsContent: HOSTS_BLOCK,
    cfg: CFG,
    logTail: ["2026-10-30T17:45:13.549Z health action=none reason=全部健康"],
    task: { output: "TaskName: ghprobe", error: "" },
  }).join("\n");
  assert.ok(lines.includes("2 个域名"));
  assert.ok(lines.includes("github.com".padEnd(32)));
  assert.ok(lines.includes("20.205.243.166"));
  assert.ok(lines.includes("备选: 20.205.243.166")); // 主 20.200.245.247 + 备选 20.205.243.166
  assert.ok(lines.includes("[缺失] cdn.jsdelivr.net"));
  assert.ok(lines.includes("[阻断] raw.githubusercontent.com"));
  assert.ok(lines.includes("2026-10-31T00:00:00.000Z"));
  assert.ok(lines.includes("每 5 分钟监督"));
  assert.ok(lines.includes("全部健康"));
});

test("buildStatusReport：空块给 install 提示；任务未注册给修复提示", () => {
  const lines = buildStatusReport({ hostsContent: "", cfg: CFG, logTail: [], task: { output: "", error: "" } }).join("\n");
  assert.ok(lines.includes("还没有 ghprobe 块"));
  assert.ok(lines.includes("未注册"));
});

test("buildStatusReport：配置里有、块里没有且不在冷却 -> 列入未写入", () => {
  // cfg 要求 api.github.com，块里没写、也没有 absent/blocked 注释
  const hosts = HOSTS_BLOCK.replace("20.205.243.168 api.github.com\n", "");
  const lines = buildStatusReport({ hostsContent: hosts, cfg: CFG, logTail: [], task: null }).join("\n");
  assert.ok(lines.includes("[未写入] api.github.com"));
  // task = null 表示非 Windows 跳过查询，不应显示「未注册」
  assert.ok(!lines.includes("未注册"));
});

test("seedIps：健康条目排最前、与静态种子去重", () => {
  const cfg = { ipPools: { seed: ["140.82.112.3", "140.82.113.4"], azure: ["20.205.243.166"] } };
  const seeds = seedIps(cfg, ["20.205.243.166", "20.27.177.113"]);
  assert.deepEqual(seeds, ["20.205.243.166", "20.27.177.113", "140.82.112.3", "140.82.113.4"]);
  assert.equal(seeds.length, new Set(seeds).size);
});

test("seedIps：无 extra 时行为与旧版一致", () => {
  const cfg = { ipPools: { seed: ["140.82.112.3"], fastly: ["185.199.108.133"] } };
  assert.deepEqual(seedIps(cfg), ["140.82.112.3", "185.199.108.133"]);
});

test("0.4.0 修正：raw 判据路径带分支段（无分支的旧路径在真 GitHub 上 404）", () => {
  const sig = sigFor("raw.githubusercontent.com", { fallbackSigs: {} });
  assert.equal(sig.path, "/torvalds/linux/master/README");
  assert.deepEqual(checkHttpResponse(200, "Linux kernel is", null, sig), { ok: true, err: "" });
  assert.equal(checkHttpResponse(404, "Not Found", null, sig).ok, false);
});

test("0.4.0 默认兜底链：fastly/testingcf/gcore 三替身自带判据，cdn.jsdelivr.net 已移除", async () => {
  const { loadConfig } = await import("../src/config.js");
  const cfg = loadConfig();
  const chain = cfg.fallbacks["raw.githubusercontent.com"];
  assert.deepEqual(chain, ["fastly.jsdelivr.net", "testingcf.jsdelivr.net", "gcore.jsdelivr.net"]);
  for (const d of chain) {
    const s = cfg.fallbackSigs[d];
    assert.ok(s && s.path === "/gh/torvalds/linux@master/README" && s.mustContain.includes("Linux kernel"), `${d} 必须自带业务判据`);
  }
  assert.ok(!chain.includes("cdn.jsdelivr.net"));
});
