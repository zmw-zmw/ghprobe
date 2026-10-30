// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 zmw
// doctor 单测：评估逻辑全走注入替身，不打真网络
import "./helpers.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  evaluateProbe, evaluateHosts, evaluateTask, evaluateDoh, overall, formatReport, runDoctor,
} from "../src/doctor.js";
import { sigFor, checkHttpResponse } from "../src/prober.js";

const CFG = {
  domains: ["github.com", "raw.githubusercontent.com"],
  fallbacks: { "raw.githubusercontent.com": ["cdn.jsdelivr.net"] },
  fallbackSigs: {},
  doh: [],
  timeouts: { dohMs: 100 },
  hosts: { maxEntriesPerDomain: 2 },
};

const HOSTS_BLOCK = `
# === ghprobe begin ===
140.82.112.3 github.com
20.27.177.113 github.com
# absent gist.githubusercontent.com 2026-10-11T00:00:00.000Z
# blocked raw.githubusercontent.com 2026-10-11T00:00:00.000Z
# === ghprobe end ===
`;

test("evaluateProbe：有活 IP = ok，附最优 IP 与延迟", () => {
  const ranked = new Map([["github.com", [{ ip: "20.27.177.113", tcpMs: 30, tlsMs: 80, ttfb: 120 }]]]);
  const checks = evaluateProbe(ranked, new Set(), CFG);
  const c = checks.find((x) => x.id === "probe:github.com");
  assert.equal(c.status, "ok");
  assert.ok(c.detail.includes("20.27.177.113"));
});

test("evaluateProbe：全灭且指纹被阻断 = warn（浏览器可能仍可用）", () => {
  const ranked = new Map([["raw.githubusercontent.com", []]]);
  const checks = evaluateProbe(ranked, new Set(["raw.githubusercontent.com"]), CFG);
  assert.equal(checks.find((x) => x.id === "probe:raw.githubusercontent.com").status, "warn");
});

test("evaluateProbe：全灭（非阻断）= fail，提示等自愈/刷池", () => {
  const ranked = new Map([["github.com", []]]);
  const checks = evaluateProbe(ranked, new Set(), CFG);
  const c = checks.find((x) => x.id === "probe:github.com");
  assert.equal(c.status, "fail");
  assert.ok(c.hint.includes("update-pool"));
});

test("evaluateHosts：空块 = fail 且建议 install", () => {
  const { checks } = evaluateHosts("", CFG, true);
  assert.equal(checks[0].status, "fail");
  assert.ok(checks[0].hint.includes("install"));
});

test("evaluateHosts：配置里的域名缺写入 = warn", () => {
  // 块里只有 github.com，cfg 还要求 api.github.com -> 缺失
  const cfg = { ...CFG, domains: ["github.com", "api.github.com"], fallbacks: {}, fallbackSigs: {} };
  const { checks } = evaluateHosts(HOSTS_BLOCK, cfg, true);
  assert.equal(checks[0].status, "warn");
  assert.ok(checks[0].detail.includes("api.github.com"));
});

test("evaluateHosts：齐了 = ok", () => {
  const cfg = { ...CFG, domains: ["github.com"], fallbacks: {}, fallbackSigs: {} };
  const { checks } = evaluateHosts(HOSTS_BLOCK, cfg, true);
  assert.equal(checks[0].status, "ok");
  assert.ok(checks[0].detail.includes("已写入 1 个域名"));
});

test("evaluateTask：注册 / 未注册 / 查询失败 / 非 Windows 四种表述", () => {
  assert.equal(evaluateTask({ output: "TaskName: ghprobe", error: "" }).status, "ok");
  assert.equal(evaluateTask({ output: "", error: "" }).status, "fail");
  assert.equal(evaluateTask({ output: "", error: "拒绝访问" }).status, "warn");
  assert.equal(evaluateTask(null).status, "info");
});

test("evaluateDoh：部分可用 ok，全挂 warn", () => {
  const eps = [{ name: "a" }, { name: "b" }];
  const ok = evaluateDoh([{ ep: { name: "a" }, ok: true }, { ep: { name: "b" }, ok: false }], [""]);
  assert.equal(ok.status, "ok");
  assert.ok(ok.detail.includes("a"));
  const bad = evaluateDoh(eps.map((ep) => ({ ep, ok: false })), []);
  assert.equal(bad.status, "warn");
});

test("overall：warn 不算失败，fail 才算", () => {
  assert.equal(overall([{ id: "a", status: "ok" }, { id: "b", status: "warn" }]).ok, true);
  const o = overall([{ id: "a", status: "ok" }, { id: "b", status: "fail" }]);
  assert.equal(o.ok, false);
  assert.deepEqual(o.failed, ["b"]);
});

test("formatReport：含标记与结论行", () => {
  const t = formatReport([
    { id: "a", title: "甲", status: "ok", detail: "好" },
    { id: "b", title: "乙", status: "fail", detail: "坏", hint: "去做 X" },
  ]);
  assert.ok(t.includes("[ OK ] 甲"));
  assert.ok(t.includes("[FAIL] 乙"));
  assert.ok(t.includes("↳ 去做 X"));
  assert.ok(t.includes("结论：1 项需要处理"));
});

test("runDoctor：断网短路，只给网络结论", async () => {
  const r = await runDoctor(CFG, () => {}, { hasNetwork: async () => false });
  assert.equal(r.ok, false);
  assert.equal(r.checks.length, 1);
  assert.equal(r.checks[0].id, "network");
  assert.equal(r.checks[0].status, "fail");
});

test("runDoctor：全链路注入替身 -> ok", async () => {
  const probe = async () => ({
    ranked: new Map([
      ["github.com", [{ ip: "20.27.177.113", tcpMs: 30, tlsMs: 80, ttfb: 120 }]],
      ["raw.githubusercontent.com", []],
    ]),
    raw: [{ domain: "raw.githubusercontent.com", ok: false, tlsBlocked: true }],
  });
  const r = await runDoctor(CFG, () => {}, {
    hasNetwork: async () => true,
    probe,
    readHosts: () => HOSTS_BLOCK,
    taskQuery: async () => ({ output: "TaskName: ghprobe", error: "" }),
  });
  // raw 的 TLS 全阻断 -> raw 域名 warn；其余 ok -> 整体 ok
  assert.equal(r.ok, true);
  assert.ok(r.checks.some((c) => c.id === "probe:raw.githubusercontent.com" && c.status === "warn"));
  assert.ok(r.checks.some((c) => c.id === "task" && c.status === "ok"));
});

test("api.github.com 探测判据：/rate_limit 200 含 rate 放行，404 拦下", () => {
  const sig = sigFor("api.github.com", CFG);
  assert.equal(sig.path, "/rate_limit");
  assert.deepEqual(checkHttpResponse(200, '{"resources":{"rate":{"limit":60}}}', null, sig), { ok: true, err: "" });
  assert.equal(checkHttpResponse(200, "Fastly error: unknown domain", null, sig).ok, false);
  assert.equal(checkHttpResponse(404, "Not Found", null, sig).ok, false);
});
