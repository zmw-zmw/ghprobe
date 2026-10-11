#!/usr/bin/env node
// ghprobe CLI：probe / serve / hosts / install / uninstall
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { Command } from "commander";
import { loadConfig } from "../src/config.js";
import { probeNow, startServer } from "../src/server.js";
import { buildBlock, mergeHosts, applyHosts, restoreHosts, WIN_HOSTS } from "../src/hosts.js";
import { readFileSync } from "node:fs";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
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
      const block = buildBlock(r.ranked, r.extra);
      const merged = mergeHosts(readFileSync(WIN_HOSTS, "utf8"), block);
      const res = await applyHosts(merged);
      console.log(`hosts 已写入，备份在 ${res.backup}`);
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
    console.log(buildBlock(r.ranked, r.extra));
  });

program.command("install")
  .description("注册 Windows 计划任务：定时探测并写入 hosts")
  .option("-c, --config <path>", "用户配置覆盖（间隔取 schedule.intervalHours）")
  .action(async (opts) => {
    const cfg = loadConfig(opts.config);
    const hours = cfg.schedule.intervalHours || 6;
    const bin = path.join(ROOT, "bin", "ghprobe.js");
    // 用 Register-ScheduledTask 而非 schtasks：/TR 的嵌套引号在 cmd 里必打架
    const cfgArg = opts.config ? ` -c "${opts.config}"` : "";
    const ps = `$a = New-ScheduledTaskAction -Execute '${process.execPath}' -Argument '"${bin}" probe --apply${cfgArg}';`
      + ` $t = New-ScheduledTaskTrigger -Once -At (Get-Date) -RepetitionInterval (New-TimeSpan -Hours ${hours});`
      + ` Register-ScheduledTask -TaskName ghprobe -Action $a -Trigger $t -Force | Out-Null`;
    const p = spawnSync("powershell", ["-NoProfile", "-Command", ps], { encoding: "utf8" });
    if (p.status === 0) { console.log(`计划任务 ghprobe 已注册：每 ${hours} 小时探测并写入 hosts（probe --apply）`); }
    else { console.error(`注册失败: ${p.stderr || p.stdout}`); process.exitCode = 1; }
  });

program.command("uninstall")
  .description("删除 ghprobe 计划任务并还原 hosts")
  .action(async () => {
    // 先还原 hosts，再删计划任务；删任务失败也不影响 hosts 回滚
    await restoreHosts();
    console.log("hosts 已还原");
    const p = spawnSync("powershell", ["-NoProfile", "-Command", "Unregister-ScheduledTask -TaskName ghprobe -Confirm:$false"], { encoding: "utf8" });
    if (p.status === 0) { console.log("计划任务 ghprobe 已删除"); }
    else { console.error(`删除计划任务失败（可能不存在）: ${p.stderr || p.stdout}`); }
  });

program.parseAsync();
