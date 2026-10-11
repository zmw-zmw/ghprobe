// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 zmw
// 离线单测：排名与兜底链决策
import { test } from "node:test";
import assert from "node:assert/strict";
import { rank, neededFallbacks } from "../src/ranker.js";

const cfg = { probe: { maxPerDomain: 2 }, fallbacks: { "raw.githubusercontent.com": ["cdn.jsdelivr.net"] } };

function r(domain, ip, score, ok = true) { return { domain, ip, score, ok }; }

test("rank: 过滤失败 + score 升序 + 限量", () => {
  const rs = [
    r("d.com", "1.1.1.1", 300), r("d.com", "2.2.2.2", 100), r("d.com", "3.3.3.3", 200),
    r("d.com", "4.4.4.4", 1, false),
  ];
  const m = rank(rs, cfg);
  const list = m.get("d.com");
  assert.equal(list.length, 2);
  assert.deepEqual(list.map((x) => x.ip), ["2.2.2.2", "3.3.3.3"]);
});

test("neededFallbacks: 全灭才出兜底", () => {
  const okMap = rank([r("raw.githubusercontent.com", "1.2.3.4", 50)], cfg);
  assert.deepEqual(neededFallbacks(okMap, cfg), []);
  const deadMap = rank([r("raw.githubusercontent.com", "1.2.3.4", 50, false)], cfg);
  assert.deepEqual(neededFallbacks(deadMap, cfg), ["cdn.jsdelivr.net"]);
});

// 回归用例：部分更新（health 只发现某 1 个域名坏了）时只探被点名的域名，
// 未被探测的域名在 ranked 里**没有键**。若把「没探」误当「全灭」，每轮都会白跑一次
// 兜底 DoH + 探测（实测多花 2~5s），而这恰恰发生在最需要快的时刻。
test("neededFallbacks: 本轮没探过的域名不触发兜底（部分更新场景）", () => {
  const onlyGithub = rank([r("github.com", "1.1.1.1", 50)], cfg);
  assert.equal(onlyGithub.has("raw.githubusercontent.com"), false, "前提：未探测的域名不建键");
  assert.deepEqual(neededFallbacks(onlyGithub, cfg), []);
});
