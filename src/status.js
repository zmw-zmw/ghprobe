// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 zmw
// status：秒级速查。与 doctor 的区别:doctor 跑一轮完整探测(~1 分钟)给诊断,
// status **不打任何网络请求**,只把「hosts 里现在写了什么 / 自愈日志最近发生了什么 /
// 计划任务在不在」摆出来 —— 日常「现在什么情况」用这个,坏了再上 doctor。
import fs from "node:fs";
import path from "node:path";
import { parseBlock, targetDomains } from "./health.js";
import { userDataDir, WIN_HOSTS } from "./hosts.js";
import { readHeartbeat, heartbeatFresh, processAlive } from "./daemon.js";

export function healthLogPath() {
  return path.join(userDataDir(), "ghprobe.log");
}

// 读健康检查日志最后 n 行(文件不存在/读不了返回 [])
export function readLogTail(n = 8, logPath = healthLogPath()) {
  try {
    const lines = fs.readFileSync(logPath, "utf8").trimEnd().split(/\r?\n/);
    return lines.slice(-n);
  } catch { return []; }
}

// 从 hosts 内容取块生成时间(# generated <ts> by ghprobe)，没有则 null
function generatedAt(content) {
  const m = String(content || "").match(/^# generated (\S+) by ghprobe$/m);
  return m ? m[1] : null;
}

// 纯函数：由既有状态组装速查报告。全离线 —— 不探测、不解析、不查任务网络。
export function buildStatusReport({ hostsContent = "", cfg, logTail = [], task = null, daemon = undefined }) {
  const current = parseBlock(hostsContent);
  const targets = targetDomains(cfg);
  const lines = [];

  // ① hosts 块现状
  const gen = generatedAt(hostsContent);
  if (!current.entries.size) {
    lines.push("hosts：还没有 ghprobe 块 —— 先跑 ghprobe install");
  } else {
    lines.push(`hosts：${current.entries.size} 个域名（块生成于 ${gen ?? "?"}）`);
    for (const [d, ip] of current.entries) {
      const alts = (current.extras.get(d) || []).join(", ");
      lines.push(`  ${d.padEnd(32)} ${ip}${alts ? `  备选: ${alts}` : ""}`);
    }
  }
  const cooling = new Set([...current.absent.keys(), ...(current.blocked || new Map()).keys()]);
  const missing = targets.filter((d) => !current.entries.has(d) && !cooling.has(d));
  for (const [d, ts] of current.absent) { lines.push(`  [缺失] ${d}（${ts} 起冷却）`); }
  for (const [d, ts] of (current.blocked || new Map())) { lines.push(`  [阻断] ${d}（${ts} 起冷却；浏览器栈也验证过被拦，详见 README §3）`); }
  if (missing.length) { lines.push(`  [未写入] ${missing.join(", ")}（下轮健康检查自动补）`); }

  // ② 常驻守护 + 计划任务
  if (daemon === undefined) { daemon = readHeartbeat(); }
  if (daemon && heartbeatFresh(daemon) && processAlive(daemon.pid)) {
    const age = Math.round((Date.now() - new Date(daemon.at).getTime()) / 1000);
    lines.push(`常驻守护：运行中（pid ${daemon.pid}，心跳 ${age}s 前，15~45s 自适应自愈）`);
  } else if (daemon) {
    lines.push("常驻守护：未运行（心跳陈旧）—— 监督者会在下一分钟自动拉起");
  } else {
    lines.push("常驻守护：未启动过 —— 下一轮 health（≤1 分钟）自动拉起");
  }
  if (task === null || task === undefined) {
    lines.push("计划任务：查询跳过（仅 Windows）");
  } else if (task.output && /ghprobe/i.test(task.output)) {
    lines.push("计划任务：已注册，每分钟自愈中");
  } else {
    lines.push(`计划任务：${task.error ? `查询失败 ${task.error}` : "未注册 —— 跑 ghprobe install"}`);
  }

  // ③ 自愈日志尾部
  if (logTail.length) {
    lines.push(`自愈日志（最近 ${logTail.length} 条，完整见 ${healthLogPath()}）：`);
    for (const l of logTail) { lines.push(`  ${l}`); }
  } else {
    lines.push("自愈日志：暂无（还没跑过 health，或日志不可读）");
  }
  return lines;
}

// 一轮速查。deps 全可注入（单测不打文件系统/任务）。
export async function runStatus(cfg, deps = {}) {
  const hostsContent = deps.hostsContent ?? (() => { try { return fs.readFileSync(WIN_HOSTS, "utf8"); } catch { return ""; } })();
  const logTail = deps.logTail ?? readLogTail();
  const task = deps.taskQuery ? await deps.taskQuery() : null;
  const lines = buildStatusReport({ hostsContent, cfg, logTail, task });
  return { lines, entries: parseBlock(hostsContent).entries.size };
}
