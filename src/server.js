// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 zmw
// 内置 HTTP API：既是测试钩子也是状态面板数据源
// GET  /api/status  最近一轮结果
// POST /api/probe   立即触发一轮探测（跑完返回摘要）
// GET  /api/hosts   当前生成的 hosts 块
// GET  /api/config  当前生效配置
import http from "node:http";
import { runProbe } from "./probe.js";
import { blockFromProbeResult } from "./health.js";

const state = { results: null, block: "", at: null, probing: false };

export function getState() { return state; }

// run 可注入（默认真实 runProbe），供接口测试替身使用
export async function probeNow(cfg, log, run = runProbe) {
  if (state.probing) { throw new Error("已有探测在跑"); }
  state.probing = true;
  try {
    const r = await run(cfg, log);
    state.results = r;
    state.at = r.at;
    state.block = blockFromProbeResult(cfg, r);
    return r;
  } finally {
    state.probing = false;
  }
}

export function startServer(cfg, log, run = runProbe) {
  const server = http.createServer((req, res) => {
    const json = (code, obj) => { res.writeHead(code, { "content-type": "application/json; charset=utf-8" }); res.end(JSON.stringify(obj, null, 2)); };
    if (req.url === "/api/status") {
      if (!state.results) { return json(200, { ready: false, probing: state.probing }); }
      const summary = [...state.results.ranked].map(([domain, rs]) => ({ domain, alive: rs.map((r) => ({ ip: r.ip, tcpMs: r.tcpMs, tlsMs: r.tlsMs, ttfb: r.ttfb, score: r.score })) }));
      return json(200, { ready: true, at: state.at, probing: state.probing, domains: summary });
    }
    if (req.url === "/api/probe" && req.method === "POST") {
      return probeNow(cfg, log, run).then((r) => {
        const summary = [...r.ranked].map(([domain, rs]) => ({ domain, alive: rs.map((x) => ({ ip: x.ip, score: x.score })) }));
        json(200, { at: r.at, domains: summary });
      }).catch((e) => json(500, { error: String(e.message) }));
    }
    if (req.url === "/api/hosts") {
      res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
      return res.end(state.block || "# 尚无结果，先 POST /api/probe\n");
    }
    if (req.url === "/api/config") { return json(200, cfg); }
    res.writeHead(404, { "content-type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ error: "not found" }));
  });
  return new Promise((resolve) => {
    server.listen(cfg.serve.port, cfg.serve.host, () => resolve(server));
  });
}
