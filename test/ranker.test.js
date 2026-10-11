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
