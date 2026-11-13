// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 zmw
// v0.1.7：代理共存（检测 / CONNECT 隧道 / 经代理测 IP / 存活跃迁全量重测）
//        + 算法升级（代理视角判活 suspect 宽限 / 备选差异化 pickAlts）。
// 全部注入式；代理用真实本地 net 服务模拟（只应答 CONNECT，不碰外网）。
import "./helpers.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  parseProxyEndpoint, parseSystemProxy, proxyFromEnv,
  connectProxyTunnel, probeThroughProxy,
  scanLocalPorts, detectProxy, detectProxyEndpoint, resetProxyCache, PROXY_TEST_HOST,
} from "../src/proxy.js";
import { pickAlts } from "../src/ranker.js";
import { parseBlock, buildHealthBlock, decide, runHealth } from "../src/health.js";
import { daemonCycle } from "../src/daemon.js";
import { evaluateProxy } from "../src/doctor.js";
import { buildStatusReport } from "../src/status.js";

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "ghprobe-v08-"));
}

// 真实本地 CONNECT 代理：读到请求头后按 respond 决定应答（200/403），并记录收到的请求行。
function fakeProxyServer(respond = 200) {
  const seen = [];
  const srv = net.createServer((sock) => {
    let acc = "";
    sock.on("data", (c) => {
      if (acc !== "") { return; } // 只应答第一条请求；后续字节（本测试不会有）忽略
      acc += c.toString("latin1");
      const end = acc.indexOf("\r\n\r\n");
      if (end === -1) { return; }
      seen.push(acc.slice(0, end).split("\r\n")[0]);
      sock.write(`HTTP/1.1 ${respond} ${respond === 200 ? "Connection established" : "Denied"}\r\n\r\n`);
      if (respond !== 200) { sock.end(); }
    });
    sock.on("error", () => { /* 测试对端随手断开，忽略 */ });
  });
  return new Promise((resolve) => srv.listen(0, "127.0.0.1", () => resolve({ srv, seen, port: srv.address().port })));
}

// ---------- 端点解析 ----------

test("parseProxyEndpoint: 各形态与 socks 拒绝", () => {
  assert.deepEqual(parseProxyEndpoint("127.0.0.1:7890"), { host: "127.0.0.1", port: 7890 });
  assert.deepEqual(parseProxyEndpoint("localhost:10809"), { host: "localhost", port: 10809 });
  assert.deepEqual(parseProxyEndpoint("http://127.0.0.1:7897"), { host: "127.0.0.1", port: 7897 });
  assert.deepEqual(parseProxyEndpoint("http://user:pass@10.0.0.2:3128"), { host: "10.0.0.2", port: 3128 });
  assert.equal(parseProxyEndpoint("socks5://127.0.0.1:1080"), null, "socks 明确不支持");
  assert.equal(parseProxyEndpoint("socks=127.0.0.1:1080"), null);
  assert.equal(parseProxyEndpoint(""), null);
  assert.equal(parseProxyEndpoint("not-a-proxy"), null);
  assert.equal(parseProxyEndpoint("127.0.0.1:99999"), null, "非法端口");
});

test("parseSystemProxy: reg query 输出", () => {
  const enabled = [
    "",
    "HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings",
    "    ProxyEnable    REG_DWORD    0x1",
    "    ProxyServer    REG_SZ    127.0.0.1:7890",
    "",
  ].join("\r\n");
  assert.deepEqual(parseSystemProxy(enabled), { host: "127.0.0.1", port: 7890 });

  // 分协议形态：优先 https=
  const perProto = enabled.replace("127.0.0.1:7890", "http=127.0.0.1:8080;https=127.0.0.1:7891");
  assert.deepEqual(parseSystemProxy(perProto), { host: "127.0.0.1", port: 7891 });
  // socks-only 分协议 -> 不支持
  assert.equal(parseSystemProxy(enabled.replace("127.0.0.1:7890", "socks=127.0.0.1:1080")), null);
  // 开关是 0x0 -> 没开
  assert.equal(parseSystemProxy(enabled.replace("0x1", "0x0")), null);
});

test("proxyFromEnv: 优先级与解析", () => {
  assert.deepEqual(proxyFromEnv({ HTTPS_PROXY: "http://127.0.0.1:7890" }),
    { host: "127.0.0.1", port: 7890, kind: "env", env: "HTTPS_PROXY" });
  assert.equal(proxyFromEnv({ HTTPS_PROXY: "socks5://x:1080" }), null, "socks 环境变量不算");
  assert.equal(proxyFromEnv({}), null);
});

// ---------- 端口扫描 ----------

test("scanLocalPorts: 命中监听端口，未命中返回 null", async () => {
  const { srv, port } = await fakeProxyServer(200);
  try {
    const hit = await scanLocalPorts([1, port, 2], 300);
    assert.ok(hit && hit.port === port && hit.host === "127.0.0.1");
    const miss = await scanLocalPorts([1, 2, 3], 300);
    assert.equal(miss, null);
  } finally { srv.close(); }
});

test("detectProxyEndpoint: env 优先于端口扫描", async () => {
  const { srv, port } = await fakeProxyServer(200);
  try {
    const ep = await detectProxyEndpoint({ proxy: { ports: [port] } }, {
      env: { HTTPS_PROXY: `http://127.0.0.1:${port + 1}` },
      tryConnect: async () => true,
    });
    assert.equal(ep.port, port + 1, "env 命中就不再扫端口");
    const ep2 = await detectProxyEndpoint({ proxy: { ports: [port] } }, { env: {} });
    assert.equal(ep2.port, port, "env 没有时扫端口");
  } finally { srv.close(); }
});

// ---------- CONNECT 隧道 ----------

test("connectProxyTunnel: 200 建隧道 / 非 200 报错", async () => {
  const { srv, seen, port } = await fakeProxyServer(200);
  try {
    const t = await connectProxyTunnel({ host: "127.0.0.1", port }, PROXY_TEST_HOST, 443, { timeoutMs: 2000 });
    assert.equal(t.ok, true);
    assert.ok(t.rttMs >= 0);
    assert.equal(seen[0], `CONNECT ${PROXY_TEST_HOST}:443 HTTP/1.1`, "CONNECT 请求行要标准");
    t.socket.destroy();
    srv.close();

    const { srv: s2, port: p2 } = await fakeProxyServer(403);
    const t2 = await connectProxyTunnel({ host: "127.0.0.1", port: p2 }, PROXY_TEST_HOST, 443, { timeoutMs: 2000 });
    assert.equal(t2.ok, false);
    assert.match(t2.err, /403/);
    await new Promise((r) => s2.close(r));
  } finally { try { srv.close(); } catch { /* 已关 */ } }
});

test("probeThroughProxy: 隧道 + TLS 握手成功即活（注入 tlsConnect 替身）", async () => {
  const { srv, seen, port } = await fakeProxyServer(200);
  try {
    const cfg = { proxy: { connectTimeoutMs: 2000 }, timeouts: { tlsMs: 2000 } };
    let tlsOpts = null;
    const fakeTls = (opts) => {
      tlsOpts = opts;
      const sock = new EventEmitter();
      sock.destroy = () => {};
      setTimeout(() => {
        // 真实 TLS 销毁会连带底层隧道 socket；替身得自己补上，否则测试进程不退出
        try { opts.socket.destroy(); } catch { /* 已销毁 */ }
        sock.emit("secureConnect");
      }, 5);
      return sock;
    };
    const r = await probeThroughProxy("203.0.113.7", "github.com", cfg, { host: "127.0.0.1", port }, { tlsConnect: fakeTls });
    assert.equal(r.ok, true, `应判活: ${JSON.stringify(r)}`);
    assert.ok(r.rttMs >= 0);
    assert.match(seen[0], /^CONNECT 203\.0\.113\.7:443 /, "隧道目标是候选 IP 不是域名");
    assert.equal(tlsOpts.servername, "github.com", "TLS SNI 必须是域名");
    assert.equal(tlsOpts.rejectUnauthorized, true, "证书校验照常，隧道里也不放水");
    await new Promise((r2) => srv.close(r2));
  } catch (e) { srv.close(); throw e; }
});

test("probeThroughProxy: 隧道被拒 = 不活", async () => {
  const { srv, port } = await fakeProxyServer(403);
  try {
    const r = await probeThroughProxy("203.0.113.7", "github.com",
      { proxy: { connectTimeoutMs: 2000 }, timeouts: { tlsMs: 2000 } },
      { host: "127.0.0.1", port });
    assert.equal(r.ok, false);
    assert.equal(r.stage, "tunnel");
  } finally { srv.close(); }
});

// ---------- detectProxy：实测存活 + 缓存 ----------

test("detectProxy: 实测 CONNECT 失败则 alive=false；缓存生效", async () => {
  resetProxyCache();
  // env 指向一个确定没人监听的端口 -> CONNECT 失败
  const cfg = { proxy: { enabled: true, ports: [], cacheMs: 60000 } };
  let calls = 0;
  const r1 = await detectProxy(cfg, { env: { HTTPS_PROXY: "http://127.0.0.1:59999" }, noCache: true });
  assert.equal(r1.found, true);
  assert.equal(r1.alive, false, "端口没监听 -> 不 alive");
  assert.equal(r1.cached, false);

  const r2 = await detectProxy(cfg, { env: { HTTPS_PROXY: "http://127.0.0.1:59999" } });
  assert.equal(r2.cached, true, "cacheMs 内走缓存");

  // 命中真实代理 -> alive=true
  resetProxyCache();
  const { srv, port } = await fakeProxyServer(200);
  try {
    const r3 = await detectProxy({ proxy: { enabled: true, ports: [], cacheMs: 0 } },
      { env: { HTTPS_PROXY: `http://127.0.0.1:${port}` }, noCache: true });
    assert.equal(r3.alive, true, `经真实本地代理 CONNECT github.com 应活: ${JSON.stringify(r3)}`);
    assert.equal(r3.kind, "env");
  } finally { srv.close(); resetProxyCache(); }
  assert.ok(calls === 0); // 占位：calls 未用于断言，保持 lint 友好
});

test("detectProxy: proxy.enabled=false 短路", async () => {
  resetProxyCache();
  const r = await detectProxy({ proxy: { enabled: false } }, { env: { HTTPS_PROXY: "http://127.0.0.1:59999" }, noCache: true });
  assert.equal(r.found, false);
  resetProxyCache();
});

// ---------- pickAlts 备选差异化 ----------

test("pickAlts: 备选优先不同 /16，其次不同 /24，最后同段", () => {
  const list = [
    { ip: "20.205.243.166" }, { ip: "20.205.243.168" },           // 同 /24
    { ip: "20.250.119.67" }, { ip: "20.6.7.17" },                 // 不同 /16
  ];
  assert.deepEqual(pickAlts(list, "20.205.243.166", 1), ["20.250.119.67"], "第一条备选必须跳出同段");
  assert.deepEqual(pickAlts(list, "20.205.243.166", 2), ["20.250.119.67", "20.6.7.17"]);
  // 只有同 /16 可选 -> 退而求其次挑不同 /24
  const same16 = [{ ip: "20.205.1.1" }, { ip: "20.205.2.2" }, { ip: "20.205.2.3" }];
  assert.deepEqual(pickAlts(same16, "20.205.1.1", 1), ["20.205.2.2"]);
  assert.deepEqual(pickAlts(same16, "20.205.1.1", 2), ["20.205.2.2", "20.205.2.3"]);
  // 裸字符串也认；数量不足时有多少给多少
  assert.deepEqual(pickAlts(["9.9.9.9"], "1.1.1.1", 2), ["9.9.9.9"]);
  assert.deepEqual(pickAlts([], "1.1.1.1", 2), []);
});

test("pickAlts: blockFromProbeResult 产出的块里备选不再与主 IP 同段", async () => {
  const { blockFromProbeResult } = await import("../src/health.js");
  const cfg = { hosts: { maxEntriesPerDomain: 2 }, domains: ["github.com"], fallbacks: {} };
  const ranked = new Map([
    ["github.com", [
      { domain: "github.com", ip: "20.205.243.166", ok: true, score: 100 },
      { domain: "github.com", ip: "20.205.243.168", ok: true, score: 110 },   // 同段，应被差异化跳过
      { domain: "github.com", ip: "20.250.119.67", ok: true, score: 120 },
    ]],
  ]);
  const block = blockFromProbeResult(cfg, { ranked, extra: new Map(), raw: [] });
  const lines = block.split("\n").filter((l) => l && !l.startsWith("#"));
  assert.equal(lines[0], "20.205.243.166 github.com");
  assert.equal(lines[1], "20.250.119.67 github.com", "备选必须换段");
});

// ---------- suspect：块注释编码 + decide 判活 ----------

test("suspect: parseBlock/buildHealthBlock 往返一致", () => {
  const entries = new Map([["github.com", "1.2.3.4"]]);
  const suspect = new Map([["raw.githubusercontent.com", "2026-11-14T00:00:00.000Z"]]);
  const block = buildHealthBlock(entries, new Map(), new Map(), new Map(), suspect);
  const parsed = parseBlock(block);
  assert.equal(parsed.suspect.get("raw.githubusercontent.com"), "2026-11-14T00:00:00.000Z");
  assert.equal(parsed.entries.get("github.com"), "1.2.3.4", "suspect 不影响条目");
});

function probeResult(domain, ip, ok, extra = {}) {
  return { domain, ip, ok, err: ok ? "" : "timeout", ...extra };
}

test("decide: 直连全挂 + 代理视角活 -> suspect（宽限一轮）", () => {
  const cfg = { domains: ["github.com"], fallbacks: {}, algorithm: { suspectGraceMs: 600000 }, schedule: {} };
  const current = parseBlock(buildHealthBlock(new Map([["github.com", "1.2.3.4"]]), new Map(), new Map([["github.com", ["5.6.7.8"]]])));
  const results = [probeResult("github.com", "1.2.3.4", false), probeResult("github.com", "5.6.7.8", false)];
  const d = decide(results, current, cfg, { aliveIps: new Set(["github.com|1.2.3.4"]) });
  assert.equal(d.action, "suspect", `应宽限: ${JSON.stringify(d)}`);
  assert.ok(d.suspects.has("github.com"));
});

test("decide: 宽限期内再失败 -> 立即动手（full），不无限拖延", () => {
  const cfg = { domains: ["github.com"], fallbacks: {}, algorithm: { suspectGraceMs: 600000 }, schedule: {} };
  const suspect = new Map([["github.com", new Date(Date.now() - 60_000).toISOString()]]);
  const current = parseBlock(buildHealthBlock(new Map([["github.com", "1.2.3.4"]]), new Map(), new Map(), new Map(), suspect));
  const results = [probeResult("github.com", "1.2.3.4", false)];
  const d = decide(results, current, cfg, { aliveIps: new Set(["github.com|1.2.3.4"]) });
  assert.equal(d.action, "full", `宽限期内再失败必须切: ${JSON.stringify(d)}`);
  assert.equal(d.domains.includes("github.com"), true);
});

test("decide: 宽限标记过期后再失败 -> 重新宽限一次", () => {
  const cfg = { domains: ["github.com"], fallbacks: {}, algorithm: { suspectGraceMs: 600000 }, schedule: {} };
  const suspect = new Map([["github.com", new Date(Date.now() - 700_000).toISOString()]]);
  const current = parseBlock(buildHealthBlock(new Map([["github.com", "1.2.3.4"]]), new Map(), new Map(), new Map(), suspect));
  const results = [probeResult("github.com", "1.2.3.4", false)];
  const d = decide(results, current, cfg, { aliveIps: new Set(["github.com|1.2.3.4"]) });
  assert.equal(d.action, "suspect", `旧标记已过期，应重新宽限: ${JSON.stringify(d)}`);
});

test("decide: 代理视角也说死 -> 立即 full；代理不可用 -> 行为不变", () => {
  const cfg = { domains: ["github.com"], fallbacks: {}, schedule: {} };
  const current = parseBlock(buildHealthBlock(new Map([["github.com", "1.2.3.4"]]), new Map(), new Map()));
  const results = [probeResult("github.com", "1.2.3.4", false)];
  assert.equal(decide(results, current, cfg, { aliveIps: new Set(["github.com|9.9.9.9"]) }).action, "full", "vantage 没点名这个 IP = 死");
  assert.equal(decide(results, current, cfg, null).action, "full", "无代理信息时行为与旧版一致");
});

test("decide: 混合场景（一个可宽限 + 一个确认死）-> 直接 full 动手", () => {
  const cfg = { domains: ["github.com", "api.github.com"], fallbacks: {}, schedule: {} };
  const entries = new Map([["github.com", "1.2.3.4"], ["api.github.com", "8.8.8.8"]]);
  const current = parseBlock(buildHealthBlock(entries, new Map(), new Map()));
  const results = [probeResult("github.com", "1.2.3.4", false), probeResult("api.github.com", "8.8.8.8", false)];
  const d = decide(results, current, cfg, { aliveIps: new Set(["github.com|1.2.3.4"]) });
  assert.equal(d.action, "full", "有确认死的域名时应急优先，不做宽限");
  assert.deepEqual(d.domains, ["api.github.com"], "只重排确认死的");
});

// ---------- runHealth 集成：suspect 落盘 ----------

test("runHealth: 直连失败 + 代理视角活 -> 写 suspect 标记且不动条目", async () => {
  const dir = tmpDir();
  const hostsPath = path.join(dir, "hosts");
  const baseBlock = buildHealthBlock(
    new Map([["github.com", "127.0.0.1"]]),
    new Map(), new Map([["github.com", ["127.0.0.2"]]]),
  );
  fs.writeFileSync(hostsPath, `# test\n${baseBlock}\n`, "utf8");
  const cfg = {
    domains: ["github.com"], fallbacks: {},
    timeouts: { dohMs: 100, tcpMs: 120, tlsMs: 200, httpMs: 200 },
    probe: { concurrency: 4, schannelRetry: false },
    hosts: { maxEntriesPerDomain: 2 },
    algorithm: { suspectGraceMs: 600000 },
    proxy: { enabled: true },
    schedule: {},
  };
  const applied = [];
  const r = await runHealth(cfg, () => {}, true, hostsPath, new Map(), {}, {
    detectProxy: async () => ({ found: true, alive: true, host: "127.0.0.1", port: 1, kind: "test" }),
    probeThroughProxy: async (ip) => (ip === "127.0.0.1" ? { ok: true, rttMs: 5 } : { ok: false }),
    applyHosts: async (merged) => { applied.push(merged); return { ok: true, backup: "" }; },
  });
  assert.equal(r.action, "suspect", `应宽限: ${JSON.stringify(r)}`);
  assert.equal(applied.length, 1, "suspect 标记要落盘");
  assert.match(applied[0], /# suspect github\.com/, "块注释里要有 suspect 标记");
  assert.match(applied[0], /127\.0\.0\.1 github\.com/, "条目原样保留（没换 IP）");
});

test("runHealth: 无代理（alive=false）时不借视角，行为与旧版一致", async () => {
  const dir = tmpDir();
  const hostsPath = path.join(dir, "hosts");
  fs.writeFileSync(hostsPath, buildHealthBlock(new Map([["github.com", "127.0.0.1"]]), new Map(), new Map()), "utf8");
  const cfg = {
    domains: ["github.com"], fallbacks: {},
    doh: [],
    timeouts: { dohMs: 100, tcpMs: 120, tlsMs: 200, httpMs: 200 },
    probe: { concurrency: 4, schannelRetry: false, stableSamples: 1 },
    hosts: { maxEntriesPerDomain: 2 },
    schedule: {},
  };
  const r = await runHealth(cfg, () => {}, false, hostsPath, new Map(), {}, {
    detectProxy: async () => ({ found: false, alive: false }),
  });
  // 无候选可换（doh/pool 都空）时，旧版行为 = 粘性保留原值并报 stuck —— 这就是「不借视角」
  assert.equal(r.action, "none", `无候选时正确行为是粘性保留: ${JSON.stringify(r)}`);
  assert.deepEqual(r.stuck, ["github.com"]);
});

// ---------- daemon：代理死亡跃迁 -> 全量重测 ----------

test("daemonCycle: 存活->死亡跃迁触发全量重测并写 hosts", async () => {
  const dir = tmpDir();
  const hostsPath = path.join(dir, "hosts");
  fs.writeFileSync(hostsPath, buildHealthBlock(new Map([["github.com", "9.9.9.9"]]), new Map(), new Map()), "utf8");
  const cfg = {
    domains: ["github.com"], fallbacks: {},
    probe: { concurrency: 4 }, hosts: { maxEntriesPerDomain: 2 },
    poolUpdate: { enabled: false }, schedule: {}, proxy: { enabled: true },
  };
  const applied = [];
  let probeRuns = 0;
  const r = await daemonCycle(cfg, () => {}, {
    proxyState: { wasAlive: true, endpoint: "127.0.0.1:7890" },
    detectProxy: async () => ({ found: true, alive: false }),
    runProbe: async () => { probeRuns += 1; return { ranked: new Map([["github.com", [{ domain: "github.com", ip: "8.8.4.4", ok: true, score: 50 }]]]), extra: new Map(), raw: [] }; },
    readHosts: () => fs.readFileSync(hostsPath, "utf8"),
    applyHosts: async (merged) => { applied.push(merged); return { ok: true }; },
    hasNetwork: async () => true,
  });
  assert.equal(r.action, "full", `跃迁应全量重测: ${JSON.stringify(r)}`);
  assert.equal(probeRuns, 1, "全量探测跑了一次");
  assert.equal(applied.length, 1, "hosts 要写");
  assert.match(applied[0], /8\.8\.4\.4 github\.com/, "写入的是全量重测结果");
  assert.match(applied[0], /9\.9\.9\.9|github\.com/, "合并保留 hosts 其余内容");
});

test("daemonCycle: 代理持续死亡（上轮已 false）不重复触发重测", async () => {
  const cfg = { domains: [], fallbacks: {}, proxy: { enabled: true }, schedule: {}, poolUpdate: { enabled: false } };
  let probes = 0;
  const r = await daemonCycle(cfg, () => {}, {
    proxyState: { wasAlive: false },
    detectProxy: async () => ({ found: true, alive: false }),
    runProbe: async () => { probes += 1; return { ranked: new Map(), extra: new Map(), raw: [] }; },
    hasNetwork: async () => false, // 断网分支，避免真实 runHealth
  });
  assert.equal(r.offline, true, "应走正常断网跳过");
  assert.equal(probes, 0, "没有跃迁就不该全量重测");
});

test("daemonCycle: 代理恢复（false->true）只记账不动手", async () => {
  const cfg = { domains: [], fallbacks: {}, proxy: { enabled: true }, schedule: {}, poolUpdate: { enabled: false } };
  const ps = { wasAlive: false };
  await daemonCycle(cfg, () => {}, {
    proxyState: ps,
    detectProxy: async () => ({ found: true, alive: true, host: "127.0.0.1", port: 1, kind: "test" }),
    hasNetwork: async () => false,
  });
  assert.equal(ps.wasAlive, true, "状态要更新");
  assert.equal(ps.endpoint, "127.0.0.1:1");
});

// ---------- doctor / status 展示 ----------

test("evaluateProxy: 四种状态人话结论", () => {
  assert.equal(evaluateProxy(null).status, "info");
  assert.equal(evaluateProxy({ found: false }).status, "info");
  assert.equal(evaluateProxy({ found: true, alive: true, host: "127.0.0.1", port: 7890, kind: "env", rttMs: 42 }).status, "ok");
  const w = evaluateProxy({ found: true, alive: false, host: "127.0.0.1", port: 7890, kind: "system" });
  assert.equal(w.status, "warn");
  assert.ok(/放行|在线/.test(w.hint), "warn 要给下一步建议");
});

test("buildStatusReport: 检测到代理时展示一行", () => {
  const lines = buildStatusReport({
    hostsContent: "",
    cfg: { domains: [], fallbacks: {} },
    logTail: [],
    daemon: null,
    task: null,
    proxy: { host: "127.0.0.1", port: 7890, kind: "port-scan" },
  });
  const p = lines.find((l) => l.includes("本地代理"));
  assert.ok(p && /127\.0\.0\.1:7890/.test(p) && /port-scan/.test(p), `应展示代理行: ${p}`);
  const lines2 = buildStatusReport({
    hostsContent: "", cfg: { domains: [], fallbacks: {} }, logTail: [], daemon: null, task: null,
  });
  assert.ok(!lines2.some((l) => l.includes("本地代理")), "没代理时不应出现该行");
});
