// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 zmw
// DoH 联邦解析：RFC 8484 wire format，端点 IP 直连，无任何 UDP53 路径
import https from "node:https";

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
export function queryDoh(ep, name, timeoutMs) {
  return new Promise((resolve) => {
    const t0 = Date.now();
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
        const rcode = body.length > 3 ? body[3] & 0x0f : -1;
        resolve({ ep, ok: res.statusCode === 200 && rcode === 0, ms: Date.now() - t0, ips: rcode === 0 ? parseA(body) : [], err: res.statusCode !== 200 ? `http ${res.statusCode}` : `rcode ${rcode}` });
      });
    });
    req.on("timeout", () => { req.destroy(); resolve({ ep, ok: false, ms: Date.now() - t0, ips: [], err: "timeout" }); });
    req.on("error", (e) => resolve({ ep, ok: false, ms: Date.now() - t0, ips: [], err: String(e.code || e.message).slice(0, 60) }));
    req.end(buildQuery((Math.random() * 65536) | 0, name));
  });
}

// 联邦查询：全部端点并发，成功者取并集去重
export async function resolveAll(endpoints, name, timeoutMs) {
  const rs = await Promise.all(endpoints.map((ep) => queryDoh(ep, name, timeoutMs)));
  const ips = new Set();
  for (const r of rs) { for (const ip of r.ips) { ips.add(ip); } }
  return { ips: [...ips], sources: rs };
}
