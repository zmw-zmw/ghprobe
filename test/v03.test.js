// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 zmw
// 0.3.0 新逻辑单测：SSH banner 探测 / schannel 二次重探 / 双采样合并 / githubassets 判据
// 全部走本地 socket 与注入替身，不打真网络。
import "./helpers.js";
import { test, after } from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  parseSshBanner, sshProbe, probeIp, curlSchannelProbe, checkHttpResponse, sigFor,
} from "../src/prober.js";
import { mergeSamples } from "../src/ranker.js";

const CFG = {
  timeouts: { tcpMs: 2000, tlsMs: 4000, httpMs: 4000 },
  fallbackSigs: {},
  probe: { schannelRetry: true },
};

// 起一个本地 TCP 服务，onConnect 收到首个数据包后按 mode 行为
function tcpServer(mode) {
  return new Promise((resolve) => {
    const s = net.createServer((sock) => {
      if (mode === "banner") { sock.end("SSH-2.0-bantest\r\n"); return; }
      // 收到 ClientHello 后稍等再断 —— 立刻 destroy 会和客户端 connect 事件赛跑，
      // 客户端还停在 tcp 阶段就报错，模拟不出「TCP 已通、TLS 阶段被 RST」。
      sock.on("data", () => { setTimeout(() => sock.destroy(), 100); });
      if (mode === "garbage") { sock.write("HTTP/1.1 400 Bad\r\n\r\n"); }
    });
    s.listen(0, "127.0.0.1", () => resolve({ s, port: s.address().port }));
  });
}

test("parseSshBanner：合法 / 未完整 / 非 SSH", () => {
  assert.equal(parseSshBanner(Buffer.from("SSH-2.0-OpenSSH_9\r\n")), "SSH-2.0-OpenSSH_9");
  assert.equal(parseSshBanner(Buffer.from("SSH-2.0-OpenSSH_9")), null); // 还没到 \r\n
  assert.equal(parseSshBanner(Buffer.from("GET / HTTP/1.1\r\n")), ""); // 完整但不是 SSH
});

test("sshProbe：本地服务发 banner -> ok；发垃圾 -> not ssh", async () => {
  const { s, port: p1 } = await tcpServer("banner");
  const ok = await sshProbe("127.0.0.1", 2000, p1);
  s.close();
  assert.equal(ok.ok, true);
  assert.equal(ok.banner, "SSH-2.0-bantest");
  assert.ok(ok.tcpMs >= 0);

  const { s: s2, port: p2 } = await tcpServer("garbage");
  const bad = await sshProbe("127.0.0.1", 2000, p2);
  s2.close();
  assert.equal(bad.ok, false);
  assert.equal(bad.stage, "banner");
});

test("probeIp ssh 分支：ssh.github.com 走 banner 判活，字段兼容 ranker", async () => {
  const { s, port } = await tcpServer("banner");
  const r = await probeIp("ssh.github.com", "127.0.0.1", CFG, { port });
  s.close();
  assert.equal(r.ok, true);
  assert.equal(r.via, "ssh");
  assert.ok(r.score >= 0);
  assert.equal(r.banner, "SSH-2.0-bantest");
});

test("probeIp schannel 重探：Node TLS 被 RST -> 注入的 schannel 成功则活", async () => {
  const { s, port } = await tcpServer("reset");
  const fakeOk = async () => ({ ok: true, status: 200, tlsMs: 40, ttfb: 80, err: "" });
  const r = await probeIp("raw.githubusercontent.com", "127.0.0.1", CFG, { curlProbe: fakeOk, port });
  s.close();
  assert.equal(r.ok, true);
  assert.equal(r.via, "schannel");
  assert.ok(r.score > 0);
});

test("probeIp schannel 重探失败：连接层失败仍标 blocked；HTTP 层失败不标", async () => {
  const { s, port } = await tcpServer("reset");
  const dead = async () => ({ ok: false, status: -1, tlsMs: -1, ttfb: -1, err: "schannel:Connection reset" });
  const r1 = await probeIp("raw.githubusercontent.com", "127.0.0.1", CFG, { curlProbe: dead, port });
  assert.equal(r1.ok, false);
  assert.equal(r1.tlsBlocked, true);

  // HTTP 层有响应（假活 404）：TLS 其实通了，不该再算指纹阻断
  const httpFail = async () => ({ ok: false, status: 404, tlsMs: 30, ttfb: 60, err: "http:status:404" });
  const r2 = await probeIp("raw.githubusercontent.com", "127.0.0.1", CFG, { curlProbe: httpFail, port });
  assert.equal(r2.ok, false);
  assert.equal(r2.tlsBlocked, false);
  s.close();
});

test("curlSchannelProbe：注入 exec，成功路径解析状态码与耗时并校验响应体", async () => {
  const bodyFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "ghprobe-t-")), "body");
  const fakeExec = (cmd, args, opts, cb) => {
    assert.ok(cmd.endsWith("curl.exe") || cmd.includes("curl"));
    assert.ok(args.includes("--resolve"));
    assert.equal(args[args.indexOf("--resolve") + 1], "api.github.com:443:1.2.3.4");
    fs.writeFileSync(args[args.indexOf("-o") + 1], '{"resources":{"rate":{}}}');
    cb(null, "200 0.010 0.020", "");
  };
  const r = await curlSchannelProbe("1.2.3.4", "api.github.com", CFG, { exec: fakeExec, curl: "curl.exe" });
  assert.equal(r.ok, true);
  assert.equal(r.status, 200);
  assert.equal(r.tlsMs, 10);
  assert.equal(r.ttfb, 20);
  fs.rmSync(path.dirname(bodyFile), { recursive: true, force: true });
});

test("curlSchannelProbe：curl 失败 -> status=-1 交由上层判 blocked", async () => {
  const fakeExec = (cmd, args, opts, cb) => cb(new Error("exit 35"), "", "curl: (35) SSL connect error");
  const r = await curlSchannelProbe("1.2.3.4", "api.github.com", CFG, { exec: fakeExec, curl: "curl.exe" });
  assert.equal(r.ok, false);
  assert.equal(r.status, -1);
  assert.ok(r.err.includes("schannel:"));
});

test("curlSchannelProbe：找不到 curl -> null，退回旧行为", async () => {
  const r = await curlSchannelProbe("1.2.3.4", "api.github.com", CFG, { curl: "" });
  assert.equal(r, null);
});

test("mergeSamples：均值 + 失败罚分；全失败保留失败", () => {
  const first = [
    { domain: "d", ip: "a", ok: true, score: 100 },
    { domain: "d", ip: "b", ok: true, score: 200 },
    { domain: "d", ip: "c", ok: false, stage: "tcp", err: "timeout" },
  ];
  const second = [
    { domain: "d", ip: "a", ok: true, score: 300 }, // 均值 200
    { domain: "d", ip: "b", ok: false, stage: "tcp", err: "timeout" }, // 200 + 500 罚分
    { domain: "d", ip: "c", ok: false, stage: "tcp", err: "timeout" },
  ];
  const out = mergeSamples(first, second);
  const a = out.find((r) => r.ip === "a");
  const b = out.find((r) => r.ip === "b");
  const c = out.find((r) => r.ip === "c");
  assert.equal(a.score, 200);
  assert.equal(a.samples, 2);
  assert.equal(b.score, 700);
  assert.equal(b.ok, true); // 有一次活就算活
  assert.equal(c.ok, false);
});

test("mergeSamples：空 extra / 空两者不炸", () => {
  assert.equal(mergeSamples([{ domain: "d", ip: "a", ok: true, score: 5 }], []).length, 1);
  assert.deepEqual(mergeSamples([], []), []);
});

test("github.githubassets.com 判据：favicon 200 含 <svg 放行，Fastly 错误页与 404 拦下", () => {
  const sig = sigFor("github.githubassets.com", { fallbackSigs: {} });
  assert.equal(sig.path, "/favicons/favicon.svg");
  assert.deepEqual(checkHttpResponse(200, '<svg width="32" viewBox="0 0 16 16"/>', null, sig), { ok: true, err: "" });
  assert.equal(checkHttpResponse(200, "Fastly error: unknown domain", null, sig).ok, false);
  assert.equal(checkHttpResponse(404, "404 Not Found", null, sig).ok, false);
});

test("ssh.github.com 签名带 type=ssh；httpProbe 不受影响", () => {
  assert.equal(sigFor("ssh.github.com", { fallbackSigs: {} }).type, "ssh");
  assert.ok(!("type" in sigFor("github.com", { fallbackSigs: {} })));
});

// 兜底：全部用例结束后确保没有遗留 server（tcpServer 内已各自 close）
after(() => { /* 显式无操作，server 均在用例内关闭 */ });
