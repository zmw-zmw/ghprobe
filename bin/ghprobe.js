#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 zmw
// ghprobe CLI：probe / serve / hosts / install / uninstall
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { Command } from "commander";
import { loadConfig, ensureUserConfig, userConfigPath } from "../src/config.js";
import { updatePool, poolNeedsUpdate, poolCachePath } from "../src/pool.js";
import { hasLocalNetwork } from "../src/net.js";
import { probeNow, startServer } from "../src/server.js";
import { runHealth, blockFromProbeResult, shouldKeepOldBlock } from "../src/health.js";
import { mergeHosts, applyHosts, restoreHosts, WIN_HOSTS, acquireHostsLock, releaseHostsLock, runElevated, buildUninstallTaskScript, buildInstallScript, buildHiddenRunnerVbs, userDataDir } from "../src/hosts.js";
import { readFileSync } from "node:fs";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

// 健康检查日志写到用户数据目录，而不是包目录：npm 全局安装时包目录位于 node_modules 下，
// npm 升级/重装会整个换掉，日志放那儿会被清掉。
function healthLogPath() {
  return path.join(userDataDir(), "ghprobe.log");
}

// 无窗口运行包装器（VBScript）的落地路径。计划任务跑的是它，不是 node 本体。
function hiddenRunnerPath() {
  return path.join(userDataDir(), "run-hidden.vbs");
}

// 计划任务静默运行，stdout/stderr 都丢；每轮结果追加日志文件，跑挂了能查到。
// stuck 单独记：它表示「探测跑了、但这个域名本轮一个活 IP 都没找到，只能保留旧值」——
// 只看 action=none 会误以为工具没干活，其实可能是链路整体被黑洞了。
function writeHealthLog(action, reason, extra = {}) {
  const entry = `${new Date().toISOString()} health action=${action} reason=${reason}`
    + `${extra.changed && extra.changed.length ? ` changed=${extra.changed.join(",")}` : ""}`
    + `${extra.stuck && extra.stuck.length ? ` stuck=${extra.stuck.join(",")}` : ""}\n`;
  try {
    const f = healthLogPath();
    fs.mkdirSync(path.dirname(f), { recursive: true });
    // 新文件写 UTF-8 BOM：否则 PowerShell 5.1 的 Get-Content 会按系统 ANSI 解码，
    // 中文日志在用户查看时变乱码（文件本身没错，是读取端猜错编码）。
    const prefix = fs.existsSync(f) ? "" : "\ufeff";
    fs.appendFileSync(f, prefix + entry);
  } catch { /* 日志写失败不影响主流程 */ }
}

// 打印 hosts 块里的 IP 条目（install 完成后回显写入结果）
function printHostsEntries() {
  try {
    const m = readFileSync(WIN_HOSTS, "utf8").match(/# === ghprobe begin ===[\s\S]*?# === ghprobe end ===/);
    if (!m) { return; }
    for (const l of m[0].split(/\r?\n/).filter((x) => /^\d+\.\d+\.\d+\.\d+\s/.test(x))) { console.log(`  ${l}`); }
  } catch { /* 读不到就算了 */ }
}

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
    if (!(await hasLocalNetwork(cfg))) {
      console.error("本地无网络连接，跳过探测（不写 hosts）");
      process.exitCode = 1;
      return;
    }
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
    let cfg = loadConfig(opts.config);
    // 本地断网 -> 直接跳过：所有候选必然全灭，跑一轮只会刷屏并把真故障淹掉。
    if (!(await hasLocalNetwork(cfg))) {
      console.error("本地无网络连接，跳过本轮（不探测、不更新池、不写 hosts）");
      writeHealthLog("skip", "本地无网络连接");
      return;
    }
    // 到点先更新候选池（默认每天 1 次；成功失败同一档冷却，不会反复重试）。
    // 放最前：池子新了，后面的重排才有更宽的候选可用；更新成功后重新加载配置以吃进新池。
    if (poolNeedsUpdate(cfg)) {
      try {
        await updatePool(cfg, (m) => console.error(m));
        cfg = loadConfig(opts.config);
      } catch (e) {
        console.error(`候选池更新失败（忽略，用现有池继续）: ${e.message}`);
      }
    }
    const r = await runHealth(cfg, (m) => console.error(m), Boolean(opts.apply));
    writeHealthLog(r.action, r.reason, r);
  });

program.command("install")
  .description("一键开启：写一次 hosts + 注册计划任务（定时健康检查），全程只需一次 UAC")
  .option("-c, --config <path>", "用户配置覆盖（间隔取 schedule.healthMin 分钟）")
  .option("--skip-probe", "只注册计划任务，不立即探测写 hosts（等下一次定时触发）")
  .action(async (opts) => {
    // 生成用户可编辑的配置文件（已存在则不覆盖，保留用户改动）
    const ucfg = ensureUserConfig();
    const cfg = loadConfig(opts.config);
    const minutes = cfg.schedule?.healthMin ?? 1;
    console.log(`用户配置：${ucfg}`);
    console.log("（可直接编辑：候选池 / 超时 / 调度间隔都在里面，优先级高于包内默认）");
    // 断网时不探测（必然全灭），但**仍然注册计划任务** —— 有网后任务会自动跑起来
    const online = await hasLocalNetwork(cfg);
    const skipProbe = Boolean(opts.skipProbe) || !online;
    if (!online) { console.log("本地无网络连接：本次跳过探测写 hosts（计划任务仍会注册，有网后自动生效）"); }
    // 包内 bin 与当前 node 的绝对路径：npm 全局安装后二者都指向真实位置，
    // 不依赖计划任务进程的 PATH（highest runlevel 下 PATH 未必含 %APPDATA%\npm）。
    const bin = path.join(ROOT, "bin", "ghprobe.js");
    const cfgArg = opts.config ? ` -c "${opts.config}"` : "";

    // 无窗口运行：Task Scheduler 起 node.exe 必弹控制台窗口，而 node 没有隐藏窗口的开关。
    // 写一个 VBS 包装器（wscript + WScript.Shell.Run(..., 0, True) = SW_HIDE），任务改成跑它。
    // 写失败不阻断安装：退回直接跑 node，功能一样，只是会闪一下窗口。
    let vbsPath = "";
    try {
      const v = hiddenRunnerPath();
      fs.mkdirSync(path.dirname(v), { recursive: true });
      fs.writeFileSync(v, buildHiddenRunnerVbs(process.execPath, bin, `health --apply${cfgArg}`), "ascii");
      vbsPath = v;
    } catch (e) {
      console.error(`无窗口包装器写入失败（退回直接运行，可能会闪一下窗口）: ${e.message}`);
    }

    // 用 runHealth 的保守决策（只预览、不写）来算该写什么：
    // 它会先测 hosts 里已写入的 IP，健康的保留，只有确认失效的才重排。
    // 若直接拿全量探测结果覆盖，会把「本轮没抓到、但现有 IP 仍然健康」的域名误记成 absent。
    let merged = null;
    if (!opts.skipProbe) {
      console.log("正在检查现有条目并探测（约 1 分钟）…");
      const h = await runHealth(cfg, (m) => console.error(m), false);
      if (h.block) { merged = mergeHosts(readFileSync(WIN_HOSTS, "utf8"), h.block); }
      else { console.log(`hosts 无需改动：${h.reason}`); }
    }

    const tmp = path.join(os.tmpdir(), `ghprobe-install-${Date.now()}.tmp`);
    fs.writeFileSync(tmp, merged || "", "utf8");
    const writeHosts = merged != null;
    try {
      // 用 Register-ScheduledTask 而非 schtasks：/TR 的嵌套引号在 cmd 里必打架
      // RunLevel Highest：任务以管理员权限静默运行，applyHosts 不再额外弹 UAC
      // UserId 必须用 COMPUTERNAME\USERNAME（裸用户名非合法 UserId，会 E_INVALIDARG）
      const res = await runElevated(buildInstallScript({
        hostsPath: WIN_HOSTS, tmpPath: tmp, nodePath: process.execPath, binPath: bin, cfgArg, minutes, writeHosts, vbsPath,
      }));
      if (res.code !== 0) { console.error(`安装失败: ${res.err || res.out}`); process.exitCode = 1; return; }
    } catch (e) {
      console.error(`安装失败: ${e.message}`);
      process.exitCode = 1;
      return;
    } finally {
      try { fs.unlinkSync(tmp); } catch { /* 清理失败不管 */ }
    }

    console.log(`计划任务 ghprobe 已注册：每 ${minutes} 分钟健康检查（health --apply，runlevel=highest，无窗口）`);
    if (opts.skipProbe) { console.log("未写 hosts（--skip-probe）；下一次定时到点会自动处理。"); return; }
    if (merged == null) { console.log("hosts 未改动（现有条目仍然健康）。"); return; }
    console.log("hosts 已写入 ✓");
    printHostsEntries();
    console.log("停止：ghprobe uninstall");
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
    // 包装器是 ghprobe 自己生成的临时产物，顺手清掉（删不掉也不影响，下次 install 会覆盖）
    try { fs.unlinkSync(hiddenRunnerPath()); } catch { /* 不存在就算了 */ }
  });

program.command("update-pool")
  .description("从 GitHub 官方 api.github.com/meta 更新候选池缓存（每天一次即可，该 API 限 60 次/小时）")
  .option("-c, --config <path>", "用户配置覆盖")
  .action(async (opts) => {
    const cfg = loadConfig(opts.config);
    try {
      const r = await updatePool(cfg, (m) => console.error(m));
      console.log(`候选池已更新：${r.count} 个 IP`);
      console.log(`  经 ${r.via} 拉取 -> ${r.path}`);
      console.log("下次 probe / health 会自动使用 auto 池");
    } catch (e) {
      console.error(`更新失败: ${e.message}`);
      process.exitCode = 1;
    }
  });

program.command("config-path")
  .description("打印用户配置文件与池缓存的路径（配置文件可直接编辑）")
  .action(() => {
    console.log(`配置：${userConfigPath()}`);
    console.log(`池缓存：${poolCachePath()}`);
  });

program.parseAsync();
