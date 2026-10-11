// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 zmw
// 离线单测：DoH 报文构造与解析（不联网）
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildQuery, parseA } from "../src/doh.js";

test("buildQuery: github.com 报文结构正确", () => {
  const q = buildQuery(0x1234, "github.com");
  assert.equal(q.readUInt16BE(0), 0x1234);
  assert.equal(q.readUInt16BE(2) & 0x0100, 0x0100); // RD
  assert.equal(q.readUInt16BE(4), 1); // QDCOUNT
  const expectQname = Buffer.from([6, 0x67, 0x69, 0x74, 0x68, 0x75, 0x62, 3, 0x63, 0x6f, 0x6d, 0]);
  assert.ok(q.subarray(12, 24).equals(expectQname));
  assert.ok(q.subarray(24).equals(Buffer.from([0, 1, 0, 1]))); // QTYPE=A QCLASS=IN
});

test("buildQuery: 非法标签抛错", () => {
  assert.throws(() => buildQuery(1, "a".repeat(64) + ".com"));
  assert.throws(() => buildQuery(1, "a..b"));
});

// 手工构造应答：1 问题 + 1 答案（压缩指针名 + A 记录 140.82.121.4）
function craftAnswer() {
  const hdr = Buffer.alloc(12);
  hdr.writeUInt16BE(0x1234, 0); hdr.writeUInt16BE(0x8180, 2);
  hdr.writeUInt16BE(1, 4); hdr.writeUInt16BE(1, 6);
  const question = Buffer.from([6, 0x67, 0x69, 0x74, 0x68, 0x75, 0x62, 3, 0x63, 0x6f, 0x6d, 0, 0, 1, 0, 1]);
  const answer = Buffer.from([0xc0, 0x0c, 0, 1, 0, 1, 0, 0, 0, 0x3c, 0, 4, 140, 82, 121, 4]);
  return Buffer.concat([hdr, question, answer]);
}

test("parseA: 压缩指针答案解出 A 记录", () => {
  const ips = parseA(craftAnswer());
  assert.deepEqual(ips, ["140.82.121.4"]);
});

test("parseA: 垃圾输入不抛错", () => {
  assert.deepEqual(parseA(Buffer.alloc(0)), []);
  assert.deepEqual(parseA(null), []);
});
