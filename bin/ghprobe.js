#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 zmw
// ghprobe CLI：probe / serve / hosts / install / uninstall
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { Command } from "commander";
import { loadConfig } from "../src/config.js";
import { probeNow, startServer } from "../src/server.js";
import { runHealth, blockFromProbeResult, shouldKeepOldBlock } from "../src/health.js";
import { mergeHosts, applyHosts, restoreHosts, WIN_HOSTS, acquireHostsLock, releaseHostsLock, runElevated, buildUninstallTaskScript } from "../src/hosts.js";
import { readFileSync } from "node:fs";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

// 严格仅 Windows：hosts 路径硬编码 + Start-Process 提权 + ipconfig，非 Windows 直接给清晰报错
if (process.platform !== "win32") {
  console.error("ghprobe 当前仅支持 Windows：hosts 路径与提权机制依赖 Windows 系统");
  process.exit(1);
}
const program = new Command();
program.name("ghprobe").description("GitHub 直连优选：本地 DoH + TLS 证书终审探测 + hosts 生成（无代理）").version("0.1.0");

// 打印一轮结果的可读摘要
function printSummary(r) {
  for (const [domain, rs] of r.ranked) {
    if (!rs.length) { console.log(`[FAIL] ${domain} 主候选全灭（看兜底链）`); continue; }
    const best = rs[0];
    console.log(`[ OK ] ${domain}  best=${best.ip}  tcp=${best.tcpMs}ms tls=${best.tlsMs}ms ttfb=${best.ttfb}ms  备选 ${rs.length - 1}`);
  }
  for (const [domain, rs] of r.extra) {
    if (rs.length) { console.log(`[FBKP] ${domain} -> 兜底命中 ${rs[0].ip} (${rs[0].score})`); }
  }
}

program.command("probe")
  .description("跑一轮探测并输出结果（不写 hosts）")
  .option("-c, --config <path>", "用户配置覆盖")
  .option("-j, --json", "输出 JSON")
  .option("-a, --apply", "探测后写入系统 hosts（会弹 UAC）")
  .action(async (opts) => {
    const cfg = loadConfig(opts.config);
    const r = await probeNow(cfg, (m) => { if (!opts.json) { console.error(m); } });
    if (opts.json) {
      const out = { at: r.at, domains: [...r.ranked].map(([d, rs]) => ({ domain: d, alive: rs.map((x) => ({ ip: x.ip, tcpMs: x.tcpMs, tlsMs: x.tlsMs, ttfb: x.ttfb, score: x.score })) })), extra: [...r.extra].map(([d, rs]) => ({ domain: d, alive: rs.map((x) => x.ip) })) };
      console.log(JSON.stringify(out, null, 2));
    } else {
      printSummary(r);
    }
    if (opts.apply) {
      const lock = acquireHostsLock();
      if (!lock) {
        console.error("另一进程正在写 hosts，本轮跳过（下轮健康检查会自动补写）");
      } else {
        try {
          const current = readFileSync(WIN_HOSTS, "utf8");
          // 块格式与 health 保持一致（含 # absent 冷却），并走同一道全灭护栏
          const block = blockFromProbeResult(cfg, r);
          if (shouldKeepOldBlock(current, block)) {
            console.error("本轮全部域名不可达（疑似网络故障），保留 hosts 中的旧条目不动");
          } else {
            const res = await applyHosts(mergeHosts(current, block));
            console.log(`hosts 已写入，备份在 ${res.backup}`);
          }
        } finally { releaseHostsLock(lock); }
      }
    }
  });

program.command("serve")
  .description("启动本地 HTTP API（默认 127.0.0.1:8930）")
  .option("-c, --config <path>", "用户配置覆盖")
  .action(async (opts) => {
    const cfg = loadConfig(opts.config);
    await startServer(cfg, (m) => console.error(`[serve] ${m}`));
    console.log(`ghprobe serve -> http://${cfg.serve.host}:${cfg.serve.port}`);
    console.log("POST /api/probe 触发探测 | GET /api/status /api/hosts /api/config");
  });

program.command("hosts")
  .description("生成 hosts 块文本（先探测一次）")
  .option("-c, --config <path>", "用户配置覆盖")
  .action(async (opts) => {
    const cfg = loadConfig(opts.config);
    const r = await probeNow(cfg, (m) => console.error(m));
    console.log(blockFromProbeResult(cfg, r));
  });

program.command("health")
  .description("健康检查：只测已写入 IP，异常才全量重排换 IP（加 --apply 才写 hosts）")
  .option("-c, --config <path>", "用户配置覆盖")
  .option("-a, --apply", "检测到异常时写入系统 hosts（会弹 UAC）")
  .action(async (opts) => {
    const cfg = loadConfig(opts.config);
    const r = await runHealth(cfg, (m) => console.error(m), Boolean(opts.apply));
    // 计划任务静默运行，stdout/stderr 都丢；每轮结果追加日志文件，跑挂了能查到
    const entry = `${new Date().toISOString()} health action=${r.action} reason=${r.reason}${r.changed && r.changed.length ? ` changed=${r.changed.join(",")}` : ""}\n`;
    try { fs.appendFileSync(path.join(ROOT, "ghprobe.log"), entry); } catch { /* 日志写失败不影响主流程 */ }
  });

program.command("install")
  .description("注册 Windows 计划任务：定时健康检查，异常才全量换 IP 并写 hosts")
  .option("-c, --config <path>", "用户配置覆盖（间隔取 schedule.healthMin 分钟）")
  .action(async (opts) => {
    const cfg = loadConfig(opts.config);
    const minutes = cfg.schedule?.healthMin || 5;
    const bin = path.join(ROOT, "bin", "ghprobe.js");
    // 用 Register-ScheduledTask 而非 schtasks：/TR 的嵌套引号在 cmd 里必打架
    // RunLevel Highest：任务以管理员权限静默运行，applyHosts 不再额外弹 UAC
    // UserId 必须用 COMPUTERNAME\USERNAME（裸用户名非合法 UserId，会 E_INVALIDARG）
    // 注册本身需管理员权限，故整段放进 runElevated 自提权执行
    const cfgArg = opts.config ? ` -c "${opts.config}"` : "";
    const script = `$ErrorActionPreference = 'Stop';`
      + ` $a = New-ScheduledTaskAction -Execute '${process.execPath}' -Argument '"${bin}" health --apply${cfgArg}';`
      + ` $t = New-ScheduledTaskTrigger -Once -At (Get-Date) -RepetitionInterval (New-TimeSpan -Minutes ${minutes});`
      + ` $p = New-ScheduledTaskPrincipal -UserId "$env:COMPUTERNAME\\$env:USERNAME" -LogonType Interactive -RunLevel Highest;`
      + ` Register-ScheduledTask -TaskName ghprobe -Action $a -Trigger $t -Principal $p -Force | Out-Null`;
    const r = await runElevated(script);
    if (r.code === 0) { console.log(`计划任务 ghprobe 已注册：每 ${minutes} 分钟健康检查（health --apply，runlevel=highest）`); }
    else { console.error(`注册失败: ${r.err || r.out}`); process.exitCode = 1; }
  });

program.command("uninstall")
  .description("删除 ghprobe 计划任务并还原 hosts")
  .action(async () => {
    // 两步互相独立：任一步失败都不影响另一步，最后统一置 exitCode
    try {
      await restoreHosts();
      console.log("hosts 已还原");
    } catch (e) {
      console.error(`还原 hosts 失败: ${e.message}`);
      process.exitCode = 1;
    }
    // 删任务同样需要管理员权限：任务建在根目录且 RunLevel=Highest，非提权删会「拒绝访问」，
    // 因此这里和 install 一样走 runElevated 自提权（已提权时会话内直接执行，不再弹 UAC）。
    try {
      const r = await runElevated(buildUninstallTaskScript());
      if (r.code === 0) { console.log("计划任务 ghprobe 已删除（若本就不存在则跳过）"); }
      else { console.error(`删除计划任务失败: ${r.err || r.out}`); process.exitCode = 1; }
    } catch (e) {
      console.error(`删除计划任务失败: ${e.message}`);
      process.exitCode = 1;
    }
  });

program.parseAsync();
