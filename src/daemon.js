// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 zmw
// daemon：常驻自愈循环（0.5.0，无缝切换的核心）。
//
// 为什么需要：0.4.0 及以前的自愈靠计划任务**每分钟起一个新进程**，最坏检测延迟 60s +
// 全量重排 ~30s，实测一次抖动窗口从断到修 ~6 分钟。常驻进程把检测压到 15~45s 自适应循环，
// 故障发现→修复的全程都不再有「等下一分钟」的固定开销。
//
// 与监督者的契约（监督者 = 现有的每分钟 `health --apply` 任务，不需要重新注册）：
//   · daemon 每轮循环写心跳文件（daemon.heartbeat）
//   · 监督者看到心跳新鲜 -> 秒退（daemon 在干活）；陈旧/没有 -> 拉起新 daemon + 本轮照常兜底
//   · daemon 崩溃 -> 下一分钟监督者自动复活它；旧版本 npm 用户没有心跳文件，行为完全不变
import fs from "node:fs";
import path from "node:path";
import { userDataDir, applyHosts, mergeHosts, WIN_HOSTS, isPaused } from "./hosts.js";
import { hasLocalNetwork } from "./net.js";
import { loadConfig } from "./config.js";
import { parseBlock, runHealth, shouldKeepOldBlock } from "./health.js";
import { poolNeedsUpdate, updatePool } from "./pool.js";
import { createSwitchGate } from "./algorithm.js";

const HEARTBEAT_MAX_AGE_MS = 150_000;   // 心跳超过这个年龄视为陈旧（单轮最坏 ~90s，留余量）

export function heartbeatPath() {
  return path.join(userDataDir(), "daemon.heartbeat");
}

export function writeHeartbeat(file = heartbeatPath()) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ at: new Date().toISOString(), pid: process.pid }));
  } catch { /* 写不了就算了，监督者会按陈旧处理并兜底 */ }
}

export function readHeartbeat(file = heartbeatPath()) {
  try {
    const o = JSON.parse(fs.readFileSync(file, "utf8"));
    return o && typeof o === "object" && o.pid ? o : null;
  } catch { return null; }
}

// 心跳是否新鲜（纯函数，now 可注入）
export function heartbeatFresh(hb, now = Date.now(), maxAgeMs = HEARTBEAT_MAX_AGE_MS) {
  if (!hb || !hb.at) { return false; }
  const t = new Date(hb.at).getTime();
  return Number.isFinite(t) && now - t >= 0 && now - t < maxAgeMs;
}

// 进程是否还活着：process.kill(pid, 0) 只查存在性；EPERM = 存在但无权限（也算活着）
export function processAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) { return false; }
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === "EPERM"; }
}

// 监督者决策（纯函数）：心跳新鲜且持有者活着 -> 秒退；否则需要拉起/兜底
export function daemonRunning(hb, now = Date.now()) {
  return heartbeatFresh(hb, now) && processAlive(hb.pid) && hb.pid !== process.pid;
}

// 自适应间隔（纯函数）：
//   断网          -> 120s（断网时探测无意义，省唤醒；恢复由下一轮本地检查发现）
//   有异常/有变更  -> 15s（刚经历故障，密集盯防确认稳定）
//   全部健康      -> 45s（空闲基线；比 1 分钟任务更密，且没有进程启动开销）
export function nextIntervalMs(result, intervals = {}) {
  const { healthy = 45_000, fast = 15_000, offline = 120_000 } = intervals;
  if (!result || result.offline) { return offline; }
  const troubled = result.action !== "none" || (Array.isArray(result.stuck) && result.stuck.length > 0);
  return troubled ? fast : healthy;
}

// 单轮自愈：断网跳过 -> 到点刷池（带 hosts 健康条目当种子）-> runHealth(写 hosts)。
// deps.gate（0.6.0）：用户行为门控 —— 非紧急写入在「用户正用浏览器」时被推迟，
// 攒进门控的 pendingBlock；健康轮结束后由 flushPending 空闲落地。
export async function daemonCycle(cfg, log, deps = {}) {
  // ghprobe off 后：不探测、不写 hosts。暂停检查必须放在最前 —— 连「断网跳过」都
  // 不能先判，off 语义是「先别动我的网络」，探测请求本身也不该发。
  // deps.isPaused 可注入（单测不碰真实用户目录）。
  if ((deps.isPaused || isPaused)()) {
    return { action: "skip", reason: "已暂停（ghprobe off 恢复）", offline: false, block: null, stuck: [] };
  }
  if (!(await (deps.hasNetwork || hasLocalNetwork)(cfg))) {
    return { action: "skip", reason: "本地无网络连接", offline: true, block: null, stuck: [] };
  }
  if (poolNeedsUpdate(cfg)) {
    try {
      const cur = parseBlock(fs.readFileSync(WIN_HOSTS, "utf8"));
      await updatePool(cfg, log, [...cur.entries.values()]);
    } catch (e) {
      log(`候选池更新失败（忽略，用现有池继续）: ${e.message}`);
    }
  }
  const hooks = deps.gate ? { beforeApply: deps.gate.beforeApply } : {};
  const result = await runHealth(cfg, log, true, WIN_HOSTS, undefined, hooks);
  // 空闲落地：上轮被推迟的块，此刻成本低就写掉（含全灭护栏）
  if (deps.gate && deps.gate.pending && (!result || result.action === "none" || result.action === "deferred")) {
    try {
      await flushPending(cfg, log, deps.gate, deps.hostsPath || WIN_HOSTS, deps.applyHosts);
    } catch (e) {
      log(`推迟块落地失败（下轮重试）: ${e.message}`);
    }
  }
  return result;
}

// 把门控攒下的块落地：重读最新 hosts + 全灭护栏 + 合并写入。
// deps.applyHosts 可注入（单测不写真 hosts）。
export async function flushPending(cfg, log, gate, hostsPath = WIN_HOSTS, applyHostsImpl = applyHosts) {
  return gate.maybeFlush(cfg, log, {
    hostsPath,
    applyHosts: (merged, p) => applyHostsImpl(merged, p),
    mergeLatest: (block) => {
      const latest = fs.readFileSync(hostsPath, "utf8");
      if (shouldKeepOldBlock(latest, block)) {
        throw new Error("全灭护栏：推迟块无有效 IP 而现有条目可用，放弃落地");
      }
      return mergeHosts(latest, block);
    },
  });
}

// 常驻主循环。返回条件：单实例让位（更年轻的 daemon 在跑）或 deps.maxCycles 用完（测试）。
export async function runDaemon(cfg, log = () => {}, deps = {}) {
  const gate = deps.gate !== undefined ? deps.gate : createSwitchGate();
  const cycle = deps.cycle || ((c, l) => daemonCycle(c, l, { gate, applyHosts: deps.applyHosts, hostsPath: deps.hostsPath }));
  const sleep = deps.sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
  const intervals = deps.intervals || {};
  const maxCycles = deps.maxCycles ?? Infinity;
  const hb = readHeartbeat();
  if (daemonRunning(hb)) { return { started: false, reason: "已有 daemon 在跑（心跳新鲜）" }; }
  writeHeartbeat();
  log(`daemon 已启动 (pid ${process.pid})`);
  let cycles = 0;
  for (;;) {
    let result = null;
    let cfgNow = cfg;
    try {
      cfgNow = loadConfig(); // 每轮重载：配置编辑与池缓存更新即时生效
      result = await cycle(cfgNow, log);
      if (result && result.action) { log(`daemon cycle action=${result.action} reason=${result.reason || ""}`); }
    } catch (e) {
      log(`daemon 循环异常（不退出，继续下一轮）: ${e.message}`);
      result = { action: "error" }; // 异常按「有事」处理 -> fast 档，别在故障后睡满 2 分钟
    }
    writeHeartbeat();
    cycles += 1;
    if (cycles >= maxCycles) { return { started: true, cycles }; }
    const newer = readHeartbeat();
    if (newer && newer.pid !== process.pid && heartbeatFresh(newer) && processAlive(newer.pid)) {
      return { started: true, cycles, yielded: true }; // 让位给更年轻的实例
    }
    await sleep(nextIntervalMs(result, intervals));
  }
}
