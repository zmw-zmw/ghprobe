// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 zmw
// v0.1.9 UDP 传统 DNS 补充源：queryUdp / resolveAllUdp / 候选合并规则。
// UDP 服务器用真实 dgram 起本地替身，回放 canned DNS 报文（报文本身用 buildQuery 造）。
import "./helpers.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import dgram from "node:dgram";
import { buildQuery, parseA, queryUdp, resolveAllUdp } from "../src/doh.js";

// 起一个本地 UDP「DNS 服务器」：收到的查询按 id 回 canned A 记录
function fakeDnsServer(mode) {
  return new Promise((resolve) => {
    const sock = dgram.createSocket("udp4");
    sock.on("message", (msg, rinfo) => {
      if (mode === "wrong-id") {
        const bad = Buffer.from(msg);
        bad.writeUInt16BE((msg.readUInt16BE(0) + 1) & 0xffff, 0);
        sock.send(bad, rinfo.port, rinfo.address);
        return;
      }
      const an = mode === "two-records" ? 2 : 1;
      const reply = Buffer.alloc(12 + msg.length - 12 + 16 * an);
      msg.copy(reply, 0); // 问题段原样
      reply.writeUInt16BE(0x8180, 2); // QR=1 RD=1 RA=1, RCODE=0
      reply.writeUInt16BE(an, 6); // ANCOUNT
      let off = 12 + (msg.length - 12);
      // RR 布局:NAME(2)+TYPE(2)+CLASS(2)+TTL(4)+RDLENGTH(2)+RDATA(4) —— RDLENGTH 在 +10!
      for (let i = 0; i < an; i++) {
        reply.writeUInt16BE(0xc00c, off); // 指针指到 QNAME
        reply.writeUInt16BE(1, off + 2); // TYPE=A
        reply.writeUInt16BE(1, off + 4); // CLASS=IN
        reply.writeUInt32BE(60, off + 6); // TTL
        reply.writeUInt16BE(4, off + 10); // RDLENGTH
        reply[off + 12] = 20; reply[off + 13] = 205; reply[off + 14] = 243; reply[off + 15] = 166 + i;
        off += 16;
      }
      sock.send(reply.subarray(0, off), rinfo.port, rinfo.address);
    });
    sock.bind(0, "127.0.0.1", () => resolve({ sock, port: sock.address().port }));
  });
}

test("queryUdp: 本地 UDP DNS 应答可解析出 A 记录", async () => {
  const { sock, port } = await fakeDnsServer("one");
  try {
    const r = await queryUdp("127.0.0.1", "github.com", 2000, port);
    assert.equal(r.ok, true, `应答应成功: ${JSON.stringify(r)}`);
    assert.deepEqual(r.ips, ["20.205.243.166"], `应解析出 canned A 记录: ${JSON.stringify(r.ips)}`);
    assert.ok(r.ms >= 0);
  } finally { sock.close(); }
});

test("queryUdp: 双 A 记录都解析", async () => {
  const { sock, port } = await fakeDnsServer("two-records");
  try {
    const r = await queryUdp("127.0.0.1", "github.com", 2000, port);
    assert.deepEqual(r.ips, ["20.205.243.166", "20.205.243.167"]);
  } finally { sock.close(); }
});

test("queryUdp: id 不匹配的错位响应丢弃判死(防缓存投毒错位)", async () => {
  const { sock, port } = await fakeDnsServer("wrong-id");
  try {
    const r = await queryUdp("127.0.0.1", "github.com", 800, port);
    assert.equal(r.ok, false);
    assert.match(r.err, /id mismatch/);
  } finally { sock.close(); }
});

test("queryUdp: 无监听端口超时判死不抛", async () => {
  const r = await queryUdp("127.0.0.1", "github.com", 400, 1); // 端口 1 无人监听
  assert.equal(r.ok, false);
  assert.match(r.err, /timeout/);
});

test("resolveAllUdp: 多服务器并查取并集(ip:port 形式)", async () => {
  const s1 = await fakeDnsServer("one");
  const s2 = await fakeDnsServer("two-records");
  try {
    const { ips, sources } = await resolveAllUdp([`127.0.0.1:${s1.port}`, `127.0.0.1:${s2.port}`], "github.com", 2000);
    assert.equal(sources.length, 2);
    assert.deepEqual([...ips].sort(), ["20.205.243.166", "20.205.243.167"].sort(), "两台服务器的答案并集");
  } finally { s1.sock.close(); s2.sock.close(); }
});

test("UDP 报文与 DoH 报文同构:buildQuery 的输出可以被 parseA 解析(往返)", () => {
  const q = buildQuery(1234, "api.github.com");
  // 造一个带两个 A 记录的应答(RDLENGTH 在 +10 —— 与 fakeDnsServer 同一布局)
  const answer = Buffer.concat([q.subarray(0, q.length), Buffer.alloc(32)]);
  answer.writeUInt16BE(0x8180, 2);
  answer.writeUInt16BE(2, 6);
  let off = q.length;
  for (let i = 0; i < 2; i++) {
    answer.writeUInt16BE(0xc00c, off);
    answer.writeUInt16BE(1, off + 2);
    answer.writeUInt16BE(1, off + 4);
    answer.writeUInt32BE(30, off + 6);
    answer.writeUInt16BE(4, off + 10);
    answer[off + 12] = 57; answer[off + 13] = 155; answer[off + 14] = 223; answer[off + 15] = 240 + i;
    off += 16;
  }
  assert.deepEqual(parseA(answer.subarray(0, off)), ["57.155.223.240", "57.155.223.241"]);
});

test("loadConfig: dohUdp 默认开,3 个国产公共 DNS,与 DoH 端点不重叠", async () => {
  const { loadConfig } = await import("../src/config.js");
  const cfg = loadConfig();
  assert.equal(cfg.dohUdp.enabled, true);
  assert.deepEqual(cfg.dohUdp.servers, ["114.114.114.114", "119.29.29.29", "180.76.76.76"]);
  assert.equal(cfg.dohUdp.timeoutMs, 2000);
  for (const s of cfg.dohUdp.servers) {
    assert.ok(!cfg.doh.some((e) => e.host === s), `${s} 不应与 DoH 端点重复`);
  }
});
