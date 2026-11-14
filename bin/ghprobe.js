#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 zmw
// ghprobe CLI：probe / serve / hosts / install / uninstall
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { Command } from "commander";
import { loadConfig, ensureUserConfig, userConfigPath, userConfigSnapshotPath, configDiff } from "../src/config.js";
import { updatePool, poolNeedsUpdate, poolCachePath } from "../src/pool.js";
import { hasLocalNetwork } from "../src/net.js";
import { probeNow, startServer } from "../src/server.js";
import { runHealth, blockFromProbeResult, shouldKeepOldBlock, parseBlock } from "../src/health.js";
import { runDoctor, formatReport, queryTask } from "../src/doctor.js";
import { runStatus, readLogTail } from "../src/status.js";
import { runDaemon, readHeartbeat, heartbeatFresh, daemonRunning } from "../src/daemon.js";
import { mergeHosts, applyHosts, restoreHosts, WIN_HOSTS, acquireHostsLock, releaseHostsLock, runElevated, buildUninstallTaskScript, buildInstallScript, buildHiddenRunnerVbs, userDataDir, isPaused, setPaused, buildPauseTaskScript, buildStartTaskScript, rotateLogIfNeeded } from "../src/hosts.js";
import { maybeNotifyUpdate } from "../src/updates.js";
import { readFileSync } from "node:fs";
import { spawn } from "node:child_process";

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
  appendRawLog(entry);
}

// 通用日志追加（daemon / 监督者用普通行，health 用上面的带格式行）
function appendRawLog(line) {
  try {
    const f = healthLogPath();
    fs.mkdirSync(path.dirname(f), { recursive: true });
    // 追加前先滚动：日志只增不减的话，长跑机器几个月能攒出几十 MB（0.1.6 前实测 33MB）
    rotateLogIfNeeded(f);
    const prefix = fs.existsSync(f) ? "" : "\ufeff";
    fs.appendFileSync(f, prefix + line);
  } catch { /* 日志写失败不影响主流程 */ }
}

// 监督者：daemon 心跳陈旧时拉起新实例（分离进程，继承当前权限，随调用方退出继续存活）。
// 成功与否都不阻断本轮 —— 本轮 health 照常执行，作为 daemon 就位前的兜底。
function spawnDaemonDetached() {
  try {
    const child = spawn(process.execPath, [path.join(ROOT, "bin", "ghprobe.js"), "daemon"], {
      detached: true, stdio: "ignore", windowsHide: true,
    });
    child.unref();
    return true;
  } catch { return false; }
}

// 打印 hosts 块里的 IP 条目（install 完成后回显写入结果）
function printHostsEntries() {
  try {
    const m = readFileSync(WIN_HOSTS, "utf8").match(/# === ghprobe begin ===[\s\S]*?# === ghprobe end ===/);
    if (!m) { return; }
    for (const l of m[0].split(/\r?\n/).filter((x) => /^\d+\.\d+\.\d+\s/.test(x))) { console.log(`  ${l}`); }
  } catch { /* 读不到就算了 */ }
}

// install 完成输出里的仓库入口：只在「刚装好、刚成功」的时机出现一次，
// 不在任何其他命令里刷存在感 —— 星标是顺手的事，不是讨来的。
function printStarTip() {
  console.log("觉得有用？GitHub 点个 ⭐ 支持一下：https://github.com/zmw-zmw/ghprobe");
}

// 严格仅 Windows：hosts 路径硬编码 + Start-Process 提权 + ipconfig，非 Windows 直接给清晰报错
if (process.platform !== "win32") {
  console.error("ghprobe 当前仅支持 Windows：hosts 路径与提权机制依赖 Windows 系统");
  process.exit(1);
}
const program = new Command();
// 版本号从 package.json 读，不写死 —— 否则 npm version 之后 --version 会漂移
const PKG = JSON.parse(readFileSync(path.join(ROOT, "package.json"), "utf8"));
program.name("ghprobe").description("GitHub 直连优选：本地 DoH + TLS 证书终审探测 + hosts 生成（无代理）").version(PKG.version);

// 交互命令开头的版本提示（内部每天最多查一次 registry；只提示不自动升级，失败静默）
function notifyUpdate() {
  return maybeNotifyUpdate(PKG.version, console.log);
}

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

program.command("doctor")
  .description("一键自检：网络 / DoH / 探测 / hosts / 计划任务，人话结论 + 下一步建议")
  .option("-c, --config <path>", "用户配置覆盖")
  .action(async (opts) => {
    await notifyUpdate();
    const cfg = loadConfig(opts.config);
    console.error("ghprobe 自检中（跑一轮完整探测，约 1 分钟）…");
    const r = await runDoctor(cfg, (m) => console.error(m));
    console.log(formatReport(r.checks));
    if (!r.ok) { process.exitCode = 1; }
  });

program.command("daemon")
  .description("常驻自愈循环（由监督者自动拉起，一般不需要手动跑）：健康态 ~90s 轻探活 / 异常 15s 盯防（可配 schedule.daemon*Ms）")
  .option("-c, --config <path>", "用户配置覆盖")
  .action(async (opts) => {
    const cfg = loadConfig(opts.config);
    await runDaemon(cfg, (m) => appendRawLog(`${new Date().toISOString()} ${m}\n`));
    // 正常不返回；返回即让位/已有实例，静默退出
  });

program.command("status")
  .description("秒级速查：hosts 现状 + 自愈日志尾部 + 计划任务（不打任何网络请求）")
  .option("-c, --config <path>", "用户配置覆盖")
  .action(async (opts) => {
    await notifyUpdate();
    const cfg = loadConfig(opts.config);
    const r = await runStatus(cfg, { taskQuery: () => queryTask() });
    console.log(r.lines.join("\n"));
  });

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
      return; // JSON 是给脚本消费的，不掺提示行
    }
    await notifyUpdate();
    printSummary(r);
    if (opts.apply) {
      // 显式命令不受暂停门约束（那是给自动化设的），但要提醒用户自动化还停着
      if (isPaused()) {
        console.error("注意：当前处于暂停状态（ghprobe off），本轮按你的显式要求仍写入 hosts；恢复自动化跑 ghprobe on");
      }
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
  .option("-f, --force", "跳过 daemon 监督逻辑，本轮亲自跑（诊断用）")
  .action(async (opts) => {
    // ghprobe off 后自愈彻底停手：不探测、不写 hosts、不拉 daemon（标记由 off/on 维护）
    if (isPaused()) {
      console.error("ghprobe 处于暂停状态（ghprobe off），本轮跳过 —— 恢复跑 ghprobe on");
      writeHealthLog("skip", "已暂停（ghprobe off），本轮不探测不写 hosts");
      return;
    }
    let cfg = loadConfig(opts.config);
    // 0.5.0 监督者逻辑：daemon 心跳新鲜 -> 秒退（它在干活，重复探测纯属浪费）；
    // 心跳陈旧/没有 -> 拉起新 daemon（分离进程），本轮仍照常执行，作为 daemon 就位前的兜底。
    // daemon 崩溃 -> 下一分钟这里自动复活它。手动诊断加 --force 绕过。
    if (!opts.force) {
      const hb = readHeartbeat();
      if (daemonRunning(hb)) {
        writeHealthLog("skip", "daemon 心跳新鲜，本轮交给 daemon");
        return;
      }
      if (spawnDaemonDetached()) {
        appendRawLog(`${new Date().toISOString()} supervisor action=spawn-daemon reason=${hb ? "心跳陈旧" : "无心跳"}\n`);
      }
    }
    // 本地断网 -> 直接跳过：所有候选必然全灭，跑一轮只会刷屏并把真故障淹掉。
    if (!(await hasLocalNetwork(cfg))) {
      console.error("本地无网络连接，跳过本轮（不探测、不更新池、不写 hosts）");
      writeHealthLog("skip", "本地无网络连接");
      return;
    }
    // 到点先更新候选池（默认每天 1 次；成功失败同一档冷却，不会反复重试）。
    // 放最前：池子新了，后面的重排才有更宽的候选可用；更新成功后重新加载配置以吃进新池。
    // 0.4.0 自救：把 hosts 里**当前已写入的条目**一并当种子 —— 它们刚通过三关终审，
    // 是「当下确实能直连 GitHub」的 IP；seed 池被 SNI 整段封锁时这批 IP 往往是
    // 唯一还拉得到 meta 的入口，池子不至于永久冻结。
    if (poolNeedsUpdate(cfg)) {
      try {
        const cur = parseBlock(fs.readFileSync(WIN_HOSTS, "utf8"));
        await updatePool(cfg, (m) => console.error(m), [...cur.entries.values()]);
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
    await notifyUpdate();
    // 生成用户可编辑的配置文件（已存在则不覆盖，保留用户改动）
    const ucfg = ensureUserConfig();
    const cfg = loadConfig(opts.config);
    const minutes = cfg.schedule?.healthMin ?? 5;
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

    console.log(`监督任务 ghprobe 已注册：每 ${minutes} 分钟查心跳拉 daemon（daemon 干活，平时零探测）`);
    if (opts.skipProbe) { console.log("未写 hosts（--skip-probe）；下一次定时到点会自动处理。"); printStarTip(); return; }
    if (merged == null) { console.log("hosts 未改动（现有条目仍然健康）。"); printStarTip(); return; }
    console.log("hosts 已写入 ✓");
    printHostsEntries();
    console.log("停止：ghprobe uninstall");
    printStarTip();
  });

program.command("off")
  .description("一键暂停：剥掉 hosts 块 + 暂停计划任务 + 落暂停标记（自愈停止写入）。GitHub 回到系统默认解析；恢复用 ghprobe on")
  .action(async () => {
    // 先落标记：off 与计划任务正在跑的一轮是并发的，标记是第一动作才能保证
    // 正在跑的那轮也看到暂停，不会刚剥完块又被那一轮写回去
    setPaused(true);
    let taskOk = true;
    try {
      const r = await runElevated(buildPauseTaskScript(true));
      if (r.code !== 0) { taskOk = false; console.error(`暂停计划任务失败: ${r.err || r.out}`); }
    } catch (e) { taskOk = false; console.error(`暂停计划任务失败: ${e.message}`); }
    try {
      await restoreHosts();
      console.log("已暂停：hosts 块已剥离、DNS 缓存已刷新，GitHub 恢复系统默认解析");
    } catch (e) {
      console.error(`剥离 hosts 块失败: ${e.message}（暂停标记已落，自动化不会再写入；hosts 里可能还残留 ghprobe 条目，可手动删或重跑 ghprobe off）`);
      process.exitCode = 1;
    }
    if (taskOk) { console.log("计划任务已暂停，常驻自愈停止写入"); }
    console.log("恢复：ghprobe on（当场触发一轮健康检查，约 1 分钟内重新写好 hosts）");
    if (!taskOk) { process.exitCode = 1; }
  });

program.command("on")
  .description("恢复（ghprobe off 的逆操作）：清暂停标记 + 恢复计划任务 + 当场触发一轮健康检查")
  .action(async () => {
    setPaused(false);
    let ok = true;
    try {
      const r = await runElevated(buildPauseTaskScript(false));
      if (r.code !== 0) { ok = false; console.error(`恢复计划任务失败: ${r.err || r.out}`); }
    } catch (e) { ok = false; console.error(`恢复计划任务失败: ${e.message}`); }
    if (ok) {
      try {
        const r = await runElevated(buildStartTaskScript());
        if (r.code !== 0) { console.error(`当场触发失败: ${r.err || r.out}（不致命，下一个间隔任务会自动跑）`); }
        else { console.log("已当场触发一轮健康检查，约 1 分钟内 hosts 重新写好"); }
      } catch (e) { console.error(`当场触发失败: ${e.message}（不致命，下一个间隔任务会自动跑）`); }
    } else {
      process.exitCode = 1;
    }
    console.log("已恢复：ghprobe 自动自愈回到工作状态");
  });

program.command("uninstall")
  .description("删除 ghprobe 计划任务并还原 hosts")
  .action(async () => {
    // 暂停标记一并清掉：重装 = 全新开始，不要把上一次的 off 状态带进新装
    setPaused(false);
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
      // 手动更新同样带上健康 hosts 条目当备用种子（见 health 命令里的说明）
      const cur = parseBlock(fs.readFileSync(WIN_HOSTS, "utf8"));
      const r = await updatePool(cfg, (m) => console.error(m), [...cur.entries.values()]);
      console.log(`候选池已更新：${r.count} 个 IP`);
      console.log(`  经 ${r.via} 拉取 -> ${r.path}`);
      console.log("下次 probe / health 会自动使用 auto 池");
    } catch (e) {
      console.error(`更新失败: ${e.message}`);
      process.exitCode = 1;
    }
  });

program.command("config-path")
  .description("打印用户配置文件、默认配置快照与池缓存的路径（配置文件可直接编辑）")
  .action(() => {
    console.log(`配置：${userConfigPath()}`);
    console.log(`快照：${userConfigSnapshotPath()}（安装时的默认配置，用来判断你改过哪些键）`);
    console.log(`池缓存：${poolCachePath()}`);
  });

program.command("config-diff")
  .description("对比用户配置与当前默认配置（升级后看哪些默认改动还没生效）")
  .action(() => {
    const { hasUser, diff } = configDiff();
    if (!hasUser) {
      console.log("还没有用户配置 —— 先跑一次 `ghprobe install` 生成。");
      return;
    }
    if (!diff.length) {
      console.log("用户配置与当前默认一致，没有需要处理的差异。");
      return;
    }
    console.log(`用户配置与当前默认有 ${diff.length} 处差异：\n`);
    for (const d of diff) {
      console.log(`  ${d.key}`);
      console.log(`    你的值   : ${JSON.stringify(d.user)}`);
      console.log(`    当前默认 : ${JSON.stringify(d.def)}`);
    }
    console.log("\n想让某处跟随新默认：把用户配置里对应的键**删掉**即可（没被改过的键会自动跟随默认）。");
    console.log(`配置文件：${userConfigPath()}`);
  });

program.command("report")
  .description("生成报障诊断包：版本/系统/暂停状态/status/配置差异/hosts 块/日志尾部，复制到剪贴板并落盘（贴 issue 用）")
  .option("-o, --out <path>", "诊断包写入路径（默认 %LOCALAPPDATA%\\ghprobe\\report-<时间>.txt）")
  .action(async (opts) => {
    await notifyUpdate();
    const cfg = loadConfig();
    const lines = [];
    lines.push(`ghprobe ${PKG.version} report`);
    lines.push(`node ${process.version} / ${process.platform} / os=${os.release()} / ${new Date().toISOString()}`);
    lines.push(`暂停状态：${isPaused() ? "已暂停（ghprobe off）" : "正常"}`);
    lines.push("");
    lines.push("== status ==");
    try {
      const r = await runStatus(cfg, { taskQuery: () => queryTask() });
      lines.push(...r.lines);
    } catch (e) { lines.push(`status 失败: ${e.message}`); }
    lines.push("");
    lines.push("== config-diff ==");
    try {
      const { hasUser, diff } = configDiff();
      lines.push(hasUser ? (diff.length ? `用户配置与默认有 ${diff.length} 处差异：${diff.map((d) => d.key).join(", ")}` : "用户配置与当前默认一致") : "无用户配置（还没跑过 install）");
    } catch (e) { lines.push(`config-diff 失败: ${e.message}`); }
    lines.push("");
    lines.push("== hosts 块 ==");
    try {
      const cur = readFileSync(WIN_HOSTS, "utf8");
      const m = cur.match(/# === ghprobe begin ===[\s\S]*?(?:# === ghprobe end ===|$)/);
      lines.push(m ? m[0].trimEnd() : "(无 ghprobe 块)");
    } catch (e) { lines.push(`hosts 读取失败: ${e.message}`); }
    lines.push("");
    lines.push("== 自愈日志尾部（最近 50 行） ==");
    const tail = readLogTail(50);
    if (tail.length) { lines.push(...tail); } else { lines.push("(暂无日志)"); }
    lines.push("");
    lines.push("== 下一步 ==");
    lines.push("再跑一次 `ghprobe doctor`，把它的输出也贴进 issue（约 1 分钟，report 里放不下探测过程）。");
    const text = lines.join("\r\n") + "\r\n";
    const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    const out = opts.out || path.join(userDataDir(), `report-${stamp}.txt`);
    try {
      fs.mkdirSync(path.dirname(out), { recursive: true });
      fs.writeFileSync(out, text, "utf8");
    } catch (e) {
      console.error(`诊断包落盘失败: ${e.message}`);
      process.exitCode = 1;
    }
    // 尝试复制到剪贴板：失败不影响落盘（诊断包已在文件里）
    let copied = false;
    try {
      await new Promise((resolve) => {
        const child = spawn("clip", [], { stdio: ["pipe", "ignore", "ignore"] });
        child.on("error", () => resolve());
        child.on("close", () => { copied = true; resolve(); });
        child.stdin.on("error", () => { /* clip 不存在时 write 会 emit，别让它炸进程 */ });
        child.stdin.write(text);
        child.stdin.end();
        setTimeout(resolve, 3000); // clip 偶发不回 close，兜底别挂着
      });
    } catch { /* 复制失败不影响落盘 */ }
    console.log(copied
      ? `诊断包已复制到剪贴板（可直接粘贴进 issue），同时写在 ${out}`
      : `诊断包已写入 ${out}（剪贴板复制不可用，请手动打开复制）`);
  });

program.parseAsync();
