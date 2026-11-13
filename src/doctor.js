// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 zmw
// doctor：一键自检。把「网络 / DoH / 探测 / hosts / 计划任务」五层各查一遍，
// 输出人话结论 + 下一步该做什么 —— 面向不想读日志的普通用户。
// 评估逻辑全部拆成纯函数（输入状态、输出结论），编排函数 runDoctor 的依赖可注入，
// 测试不打真网络。
import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolveAll } from "./doh.js";
import { runProbe } from "./probe.js";
import { hasLocalNetwork } from "./net.js";
import { parseBlock, targetDomains, blockedDomainsFromRaw } from "./health.js";
import { WIN_HOSTS } from "./hosts.js";
import { detectProxy } from "./proxy.js";

// 单条结论：status = ok（正常）/ warn（能用但要注意）/ fail（有问题）/ info（仅供参考）
// hint 只在非 ok 时给「下一步做什么」，正常项不啰嗦
export function check(id, title, status, detail, hint = "") {
  return { id, title, status, detail, hint };
}

// 从一轮探测结果逐域名给结论。
// 三类情形要分开说：有活 IP（ok）／候选全灭但疑似 TLS 指纹被阻断（warn：浏览器可能仍能用，
// 换 IP 修不了）／候选全灭（fail：等自愈或查池）。
// tlsBlockedDomains 由 blockedDomainsFromRaw() 算出，这里不重复判 —— 单一事实来源。
export function evaluateProbe(ranked, tlsBlockedDomains, cfg) {
  const out = [];
  for (const domain of cfg.domains) {
    const rs = ranked.get(domain) || [];
    if (rs.length) {
      const best = rs[0];
      out.push(check(`probe:${domain}`, `探测 ${domain}`,
        "ok", `最优 ${best.ip}（tcp ${best.tcpMs}ms / tls ${best.tlsMs}ms / 首字节 ${best.ttfb}ms），共 ${rs.length} 个可用`));
    } else if (tlsBlockedDomains.has(domain)) {
      out.push(check(`probe:${domain}`, `探测 ${domain}`, "warn",
        "候选全部在 TLS 阶段被重置 —— 本机探测客户端（Node）的 TLS 指纹被识别，换 IP 修不了",
        "你的浏览器很可能仍能正常访问该域名；若浏览器也不行，只能换域名入口（兜底链，见 README 第 6 节）"));
    } else {
      out.push(check(`probe:${domain}`, `探测 ${domain}`, "fail",
        "所有候选 IP 都不可用",
        "稍等几分钟让计划任务自动重排；持续如此先跑 `ghprobe update-pool` 刷新候选池，再不行就是该网络到 GitHub 的链路整体不可达"));
    }
  }
  return out;
}

// hosts 块状态：有没有写、写的够不够。探测结果（ranked）与 hosts 是两回事 ——
// 「本轮测出了活 IP」不等于「已经写进 hosts」，doctor 要把两者对上。
export function evaluateHosts(content, cfg, probed = true) {
  const current = parseBlock(content);
  const n = current.entries.size;
  if (n === 0 && current.idle.size > 0) {
    // 0.1.8 代理保活模式：条目被注释不是「没装好」，是代理共存设计 —— 单独说清楚
    return { state: current, checks: [check("hosts", "hosts 写入状态", "info",
      `代理保活模式：${current.idle.size} 个域名的直连条目已注释（检测到本地代理存活时自动启用）`,
      "停止代理后 ghprobe 会自动把保活条目转正（无缝恢复直连）；不想要此模式可配置 proxy.idleMode: false")] };
  }
  if (n === 0) {
    return { state: current, checks: [check("hosts", "hosts 写入状态", probed ? "fail" : "info",
      "hosts 里还没有 ghprobe 块",
      probed ? "运行 `ghprobe install`：写入 hosts 并注册每分钟自愈的计划任务（一次 UAC）" : "")] };
  }
  const targets = targetDomains(cfg);
  const absent = [...current.absent.keys()];
  const blocked = [...(current.blocked || new Map()).keys()];
  // 「未写入」只算真正没写入的：absent/blocked 域名有专门的状态注释，不算缺失，
  // 否则同一个域名会在 detail 里出现两遍，读起来像出了两个问题。
  const cooling = new Set([...absent, ...blocked]);
  const missing = targets.filter((d) => !current.entries.has(d) && !cooling.has(d));
  const detail = `已写入 ${n} 个域名`
    + `${absent.length ? `；缺（冷却中）: ${absent.join(", ")}` : ""}`
    + `${blocked.length ? `；探测不可判: ${blocked.join(", ")}` : ""}`;
  if (missing.length) {
    return { state: current, checks: [check("hosts", "hosts 写入状态", "warn", detail + `；配置里有但未写入: ${missing.join(", ")}`,
      "下一轮健康检查会自动补写；急用可手动跑 `ghprobe health --apply`")] };
  }
  return { state: current, checks: [check("hosts", "hosts 写入状态", "ok", detail)] };
}

// 计划任务在不在。用 schtasks 查（只读、不弹 UAC）；queryResult = { output, error } 或 null（非 Windows）。
// 查询本身失败不等于没注册，单独标 warn 而不是 fail，避免把「权限/语法问题」夸大成「自愈失效」。
export function evaluateTask(queryResult) {
  if (queryResult === null || queryResult === undefined) {
    return check("task", "计划任务（每分钟自愈）", "info", "跳过（仅 Windows 支持查询）");
  }
  if (queryResult.output && /ghprobe/i.test(queryResult.output)) {
    return check("task", "计划任务（每分钟自愈）", "ok", "已注册（ghprobe）");
  }
  if (queryResult.error) {
    return check("task", "计划任务（每分钟自愈）", "warn", `查询失败：${queryResult.error}`,
      "无法确认自愈是否在跑；可重跑 `ghprobe install` 修复");
  }
  return check("task", "计划任务（每分钟自愈）", "fail", "未注册 —— IP 失效后不会自动换",
    "运行 `ghprobe install` 注册（需要一次 UAC）");
}

// DoH 端点连通性：只要有一个端点解析成功就算过；全挂意味着候选只能靠内置池，
// 池子一过期就彻底失明，属于要提醒的问题。
export function evaluateDoh(sources, ips) {
  const ok = (sources || []).filter((s) => s.ok);
  const names = ok.map((s) => s.ep.name).join(", ");
  if (ok.length) {
    return check("doh", "DoH 解析", "ok", `${ok.length}/${sources.length} 个端点可用（${names}），解析出 ${ips.length} 个候选`);
  }
  return check("doh", "DoH 解析", "warn", "所有 DoH 端点都不可达，候选只能靠内置 IP 池",
    "内置池会过期；检查防火墙是否拦了 443 出站，或在配置里更换 doh 端点");
}

// 本地代理共存（0.1.7）：检测到且可用 -> 说明它会参与判活；检测到但不可用 -> 要提醒；
// 没检测到 -> 正常直连模式，不是问题。pi = detectProxy 结果或 null（跳过/非 Windows 环境）。
export function evaluateProxy(pi) {
  if (pi === null || pi === undefined) {
    return check("proxy", "本地代理共存", "info", "跳过（未检测或平台不支持）");
  }
  if (!pi.found) {
    return check("proxy", "本地代理共存", "info", "未检测到本地代理（直连模式）");
  }
  if (pi.alive) {
    return check("proxy", "本地代理共存", "ok",
      `检测到 ${pi.host}:${pi.port}（${pi.kind}），经它可达 GitHub（rtt ${pi.rttMs}ms）—— 直连探活失败时会借它判「IP 真死还是本机抖动」，代理停止时自动全量重测`);
  }
  return check("proxy", "本地代理共存", "warn",
    `检测到 ${pi.host}:${pi.port}（${pi.kind}）但经它连不上 GitHub —— 不参与判活`,
    "代理开着但到不了 GitHub：检查代理软件是否在线、分流规则是否放行 github.com；不用代理可忽略");
}

// 汇总：有无 fail。warn 不算不健康 —— blocked 域名（浏览器可能仍可用）不该让 doctor 退出码非零。
export function overall(checks) {
  const failed = checks.filter((c) => c.status === "fail");
  return { ok: failed.length === 0, failed: failed.map((c) => c.id) };
}

const MARK = { ok: "[ OK ]", warn: "[WARN]", fail: "[FAIL]", info: "[INFO]" };

export function formatReport(checks) {
  const lines = [];
  for (const c of checks) {
    lines.push(`${MARK[c.status]} ${c.title} —— ${c.detail}`);
    if (c.hint) { lines.push(`       ↳ ${c.hint}`); }
  }
  const o = overall(checks);
  lines.push(o.ok ? "结论：一切正常。" : `结论：${o.failed.length} 项需要处理（见上）。`);
  return lines.join("\n");
}

// 查计划任务（Windows）：schtasks 只读查询，不需要管理员。返回 { output, error }；
// 非 Windows 返回 null（evaluateTask 据此跳过）。deps.taskQuery 可注入以便测试。
export function queryTask(taskName = "ghprobe") {
  if (process.platform !== "win32") { return Promise.resolve(null); }
  return new Promise((resolve) => {
    execFile("schtasks", ["/query", "/tn", taskName], { windowsHide: true }, (e, stdout, stderr) => {
      resolve(e
        ? { output: "", error: stderr ? String(stderr).trim().split(/\r?\n/)[0] : String(e.message).slice(0, 80) }
        : { output: String(stdout), error: "" });
    });
  });
}

// 完整一轮自检。deps 全部可注入（测试用）；缺省用真实实现。
// 返回 { ok, checks }，CLI 层负责打印与退出码。
export async function runDoctor(cfg, log = () => {}, deps = {}) {
  const d = {
    hasNetwork: deps.hasNetwork || hasLocalNetwork,
    dohResolve: deps.dohResolve || resolveAll,
    probe: deps.probe || runProbe,
    readHosts: deps.readHosts || (() => { try { return readFileSync(WIN_HOSTS, "utf8"); } catch { return ""; } }),
    taskQuery: deps.taskQuery || queryTask,
    blockedFromRaw: deps.blockedFromRaw || null,
    detectProxy: deps.detectProxy || null,
  };
  const checks = [];

  // ① 本地网络：断网时后面的探测全无意义，直接给结论收场
  const online = await d.hasNetwork(cfg);
  checks.push(online
    ? check("network", "本地网络", "ok", "可上网")
    : check("network", "本地网络", "fail", "本机无网络连接",
      "ghprobe 修不了断网：先恢复联网，之后计划任务会自动继续"));
  if (!online) { return { ok: false, checks }; }

  // ② DoH 连通性：deps.probe 被注入（测试替身）时跳过，避免测试打真网络
  if (!deps.probe) {
    const { ips, sources } = await d.dohResolve(cfg.doh, cfg.domains[0], cfg.timeouts.dohMs);
    checks.push(evaluateDoh(sources, ips));
  }

  // ③ 一轮完整探测
  const r = await d.probe(cfg, log);
  const blocked = (d.blockedFromRaw || blockedDomainsFromRaw)(r.raw || []);
  checks.push(...evaluateProbe(r.ranked || new Map(), blocked, cfg));

  // ④ hosts 块状态
  const hosts = evaluateHosts(d.readHosts(), cfg, Boolean(deps.probe));
  checks.push(...hosts.checks);

  // ⑤ 本地代理共存（0.1.7）。deps.probe 被注入（测试替身）时跳过 —— 与 DoH 一样不打真网络。
  if (!deps.probe) {
    let pi = null;
    try { pi = await (d.detectProxy || detectProxy)(cfg); } catch { pi = { found: false, alive: false, reason: "检测失败" }; }
    checks.push(evaluateProxy(pi));
  }

  // ⑥ 计划任务
  checks.push(evaluateTask(await d.taskQuery()));

  return { ...overall(checks), checks };
}
