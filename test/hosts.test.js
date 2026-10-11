// 离线单测：hosts 块生成与合并替换
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildBlock, mergeHosts } from "../src/hosts.js";

const ranked = new Map([["github.com", [{ ip: "20.205.243.166" }, { ip: "20.27.177.113" }]]]);
const extra = new Map([["cdn.jsdelivr.net", [{ ip: "104.16.0.1" }]]]);

test("buildBlock: 含 begin/end 标记与条目", () => {
  const block = buildBlock(ranked, extra);
  assert.ok(block.startsWith("# === ghprobe begin ==="));
  assert.ok(block.endsWith("# === ghprobe end ==="));
  assert.ok(block.includes("20.205.243.166 github.com"));
  assert.ok(block.includes("104.16.0.1 cdn.jsdelivr.net"));
});

test("mergeHosts: 替换旧块且保留其他行", () => {
  const current = ["# 本机原有条目", "127.0.0.1 localhost", "# === ghprobe begin ===", "9.9.9.9 old.com", "# === ghprobe end ===", "# 尾注"].join("\n");
  const merged = mergeHosts(current, buildBlock(ranked, extra));
  assert.ok(merged.includes("127.0.0.1 localhost"));
  assert.ok(merged.includes("# 尾注"));
  assert.ok(!merged.includes("9.9.9.9 old.com"));
  assert.equal((merged.match(/ghprobe begin/g) || []).length, 1);
  assert.ok(merged.endsWith("\n"));
});

test("mergeHosts: 无旧块时追加", () => {
  const merged = mergeHosts("127.0.0.1 localhost", buildBlock(ranked, new Map()));
  assert.ok(merged.includes("20.205.243.166 github.com"));
  assert.ok(merged.includes("127.0.0.1 localhost"));
});
