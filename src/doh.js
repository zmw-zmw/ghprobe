// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 zmw
// DoH 联邦解析：RFC 8484 wire format，端点 IP 直连 + UDP 传统 DNS 补充源（0.1.9）
// UDP 补充源为什么明知可能被污染还要查：它只负责「把候选面拉宽」，不负责答案可信 ——
// 下游三关探测的 TLS 证书终审会淘汰污染 IP，污染答案进不了 hosts。
import https from "node:https";
import dgram from "node:dgram";

// 构造最小 DNS A 查询报文：header(12) + QNAME 标签串 + 根0 + QTYPE=A + QCLASS=IN
export function buildQuery(id, name) {
  if (id < 0 || id > 65535) { throw new Error("dns id out of range"); }
  const hdr = Buffer.alloc(12);
  hdr.writeUInt16BE(id, 0);
  hdr.writeUInt16BE(0x0100, 2); // RD=1
  hdr.writeUInt16BE(1, 4); // QDCOUNT=1
  const labels = [];
  for (const label of String(name).split(".")) {
    if (!label.length || label.length > 63) { throw new Error(`bad label: ${label}`); }
    labels.push(Buffer.from([label.length]), Buffer.from(label));
  }
  return Buffer.concat([hdr, ...labels, Buffer.from([0, 0, 1, 0, 1])]);
}

// 解析应答中的 A 记录；名字支持压缩指针，解析失败不抛错只返回已得结果
export function parseA(buf) {
  const ips = [];
  if (!buf || buf.length < 12) { return ips; }
  const qd = buf.readUInt16BE(4);
  const an = buf.readUInt16BE(6);
  let off = 12;
  const skipName = () => {
    for (;;) {
      if (off >= buf.length) { return; }
      const len = buf[off];
      if (len === 0) { off += 1; return; }
      if ((len & 0xc0) === 0xc0) { off += 2; return; }
      off += len + 1;
    }
  };
  for (let i = 0; i < qd; i++) { skipName(); off += 4; }
  for (let i = 0; i < an && off + 10 <= buf.length; i++) {
    skipName();
    if (off + 10 > buf.length) { break; }
    const type = buf.readUInt16BE(off);
    const rdlen = buf.readUInt16BE(off + 8);
    if (type === 1 && rdlen === 4 && off + 14 <= buf.length) {
      ips.push(`${buf[off + 10]}.${buf[off + 11]}.${buf[off + 12]}.${buf[off + 13]}`);
    }
    off += 10 + rdlen;
  }
  return ips;
}

// 单端点 DoH 查询：POST wire 报文，IP 直连 + 可选 SNI 覆盖（证书仍按 servername 校验）
// 应答只校验 query ID 是否与请求一致，不单独解析 question 段：端点是我们主动 TLS 直连的已知服务器，
// 信道经过证书校验，且 ID 已匹配，足以排除响应错位与缓存投毒；question 段校验属防御性冗余，不做
export function queryDoh(ep, name, timeoutMs) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const qid = (Math.random() * 65536) | 0;
    const qbuf = buildQuery(qid, name);
    const req = https.request({
      host: ep.host, path: ep.path || "/dns-query",
      method: "POST", timeout: timeoutMs,
      headers: { "content-type": "application/dns-message" },
      // 只在显式配了 sni 时覆盖；否则交给 node 按 host 自动推导（IP 不允许当 SNI）
      ...(ep.sni ? { servername: ep.sni } : {}),
    }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        const body = Buffer.concat(chunks);
        if (body.length < 12) { resolve({ ep, ok: false, ms: Date.now() - t0, ips: [], err: "short response" }); return; }
        const rid = body.readUInt16BE(0);
        if (rid !== qid) { resolve({ ep, ok: false, ms: Date.now() - t0, ips: [], err: `id mismatch ${rid}!==${qid}` }); return; }
        const rcode = body[3] & 0x0f;
        resolve({ ep, ok: res.statusCode === 200 && rcode === 0, ms: Date.now() - t0, ips: rcode === 0 ? parseA(body) : [], err: res.statusCode !== 200 ? `http ${res.statusCode}` : `rcode ${rcode}` });
      });
    });
    req.on("timeout", () => { req.destroy(); resolve({ ep, ok: false, ms: Date.now() - t0, ips: [], err: "timeout" }); });
    req.on("error", (e) => resolve({ ep, ok: false, ms: Date.now() - t0, ips: [], err: String(e.code || e.message).slice(0, 60) }));
    req.end(qbuf);
  });
}

// 联邦查询：全部端点并发，成功者取并集去重
export async function resolveAll(endpoints, name, timeoutMs) {
  const rs = await Promise.all(endpoints.map((ep) => queryDoh(ep, name, timeoutMs)));
  const ips = new Set();
  for (const r of rs) { for (const ip of r.ips) { ips.add(ip); } }
  return { ips: [...ips], sources: rs };
}

// ---------- UDP 传统 DNS 补充源（0.1.9） ----------
// 114.114.114.114 / 119.29.29.29 / 180.76.76.76 这些经典公共 DNS 只开 UDP 53，
// 没有任何 443 DoH（2026-11-14 实测 TCP 全不通）—— 但作为**补充答案源**依然有价值：
// 它们与 DoH 厂商的 anycast 是不同解析器，返回的 CDN 映射往往不同段。
// 报文与 DoH 同构（RFC 1035）：buildQuery 构造、parseA 解析，直接复用。
export function queryUdp(server, name, timeoutMs, port = 53) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const qid = (Math.random() * 65536) | 0;
    const qbuf = buildQuery(qid, name);
    const sock = dgram.createSocket("udp4");
    let settled = false;
    const done = (ok, ips, err) => {
      if (settled) { return; }
      settled = true;
      clearTimeout(timer);
      try { sock.close(); } catch { /* 已关 */ }
      resolve({ server, ok, ms: Date.now() - t0, ips, err: err || "" });
    };
    const timer = setTimeout(() => done(false, [], "timeout"), timeoutMs);
    sock.on("message", (msg) => {
      if (msg.length < 12) { done(false, [], "short response"); return; }
      const rid = msg.readUInt16BE(0);
      if (rid !== qid) { done(false, [], "id mismatch"); return; } // 错位响应直接丢弃
      const rcode = msg[3] & 0x0f;
      done(rcode === 0, rcode === 0 ? parseA(msg) : [], rcode === 0 ? "" : `rcode ${rcode}`);
    });
    sock.on("error", (e) => done(false, [], String(e.code || e.message).slice(0, 60)));
    sock.send(qbuf, port, server, (e) => { if (e) { done(false, [], String(e.code || e.message).slice(0, 60)); } });
  });
}

// UDP 联邦查询：全部服务器并发，成功者取并集去重（与 resolveAll 同构）。
// 服务器条目支持 "ip" 或 "ip:port"（port 缺省 53）。
export async function resolveAllUdp(servers, name, timeoutMs) {
  const targets = (servers || []).map((s) => {
    const str = String(s);
    const i = str.lastIndexOf(":");
    return /^\d+\.\d+\.\d+\.\d+:\d+$/.test(str) ? { host: str.slice(0, i), port: parseInt(str.slice(i + 1), 10) } : { host: str, port: 53 };
  });
  const rs = await Promise.all(targets.map((t) => queryUdp(t.host, name, timeoutMs, t.port)));
  const ips = new Set();
  for (const r of rs) { for (const ip of r.ips) { ips.add(ip); } }
  return { ips: [...ips], sources: rs };
}
