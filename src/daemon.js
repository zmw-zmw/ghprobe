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
import { parseBlock, runHealth, shouldKeepOldBlock, blockFromProbeResult, buildHealthBlock, activeBlockToIdle, idleToActive } from "./health.js";
import { runProbe } from "./probe.js";
import { detectProxy } from "./proxy.js";
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

// 单轮自愈：暂停跳过 -> 代理状态监测（存活->死亡跃迁即全量重测）-> 断网跳过
// -> 到点刷池（带 hosts 健康条目当种子）-> runHealth(写 hosts)。
// deps.gate（0.6.0）：用户行为门控 —— 非紧急写入在「用户正用浏览器」时被推迟，
// 攒进门控的 pendingBlock；健康轮结束后由 flushPending 空闲落地。
// deps.proxyState（0.1.7）：跨轮代理状态（runDaemon 注入持久对象）—— wasAlive 记上一轮
// 存活。一次性调用（单测/无状态路径）不传则只测不记、无跃迁逻辑。
// ---------- 代理保活状态机（0.1.8） ----------
// 用户语义：「开代理时把直连条目全部注释掉，低频保活探测直连 IP，代理停了无缝切回」。
// 三个动作：
//   进入（代理活着 & 条目还是活的）  -> 条目立即注释（# idle），注释前的条目就是初始
//                                      standby；随后全量重测建立新鲜 standby。
//                                      为什么注释是对的：流量已交代理，hosts 钉 IP 不仅无用，
//                                      在 Clash fake-ip/TUN 模式下反而会绕过代理破坏分流。
//   保活（代理持续存活）            -> 每 proxy.idleProbeMin（默认 5 分钟，远低于直连
//                                      模式的 15~45s）全量重测一次直连候选，standby 保持新鲜；
//                                      未到点时每轮只做一次缓存命中的代理检测，几乎零成本。
//   恢复（存活 -> 死亡跃迁）        -> **先把 standby 注释条目立即转正（<1s，不等重测）**，
//                                      再后台全量重测校准。恢复先于校准 —— 直连解析
//                                      0 秒内就位，这才是「无缝切换」。
// 纪律：全灭时绝不覆盖非空 standby（否则恢复=空恢复）；校准写入与现内容相同则跳过。

// 保活探测：全量重测直连候选 -> 写成 idle 注释块。供进入/保活共用。
async function keepwarmProbe(cfg, log, deps = {}, ps) {
  const hostsPath = deps.hostsPath || WIN_HOSTS;
  const readH = deps.readHosts || ((p) => fs.readFileSync(p, "utf8"));
  const apply = deps.applyHosts || applyHosts;
  // 到点刷池：池子新，恢复之后的重排才有宽候选可用（与直连模式同一份逻辑）
  if (poolNeedsUpdate(cfg)) {
    try {
      const cur = parseBlock(readH(hostsPath));
      const seeds = [...cur.entries.values()].concat([...cur.idle.values()].flat());
      await updatePool(cfg, log, seeds);
    } catch (e) {
      log(`候选池更新失败（忽略，用现有池继续）: ${e.message}`);
    }
  }
  const r = await (deps.runProbe || runProbe)(cfg, log, null); // null = 全部域名，standby 必须全覆盖
  const idleBlock = activeBlockToIdle(blockFromProbeResult(cfg, r));
  if (parseBlock(idleBlock).idle.size === 0) {
    // 全灭护栏：一个活 IP 都没有时绝不覆盖非空 standby，否则代理一停就恢复了个寂寞
    log("保活探测全灭，保留上一份 standby 不覆盖");
    ps.standbyAt = Date.now(); // 算作已测过一轮，别在黑洞窗口里反复空转
    return false;
  }
  const latest = readH(hostsPath);
  const merged = mergeHosts(latest, idleBlock);
  if (merged !== latest) {
    await apply(merged, hostsPath);
  }
  ps.standbyAt = Date.now();
  return true;
}

// 进入保活：注释现有条目（立即），随后建立新鲜 standby
async function proxyIdleEnter(cfg, log, deps = {}, ps) {
  const hostsPath = deps.hostsPath || WIN_HOSTS;
  const readH = deps.readHosts || ((p) => fs.readFileSync(p, "utf8"));
  const apply = deps.applyHosts || applyHosts;
  try {
    const latest = readH(hostsPath);
    const cur = parseBlock(latest);
    if (cur.entries.size > 0) {
      const idleBlock = buildHealthBlock(cur.entries, cur.absent, cur.extras, cur.blocked, cur.suspect, true);
      const merged = mergeHosts(latest, idleBlock);
      if (merged !== latest) { await apply(merged, hostsPath); }
      log(`本地代理已启用（${ps.endpoint || "proxy"}）：hosts 条目已注释保活，停止代理将自动无缝恢复`);
    } else {
      log(`本地代理已启用（${ps.endpoint || "proxy"}）：进入保活模式`);
    }
  } catch (e) {
    log(`注释条目失败（不影响代理使用，下一轮重试）: ${e.message}`);
    return { action: "error", reason: `保活进入失败: ${e.message}`, offline: false, block: null, stuck: [], proxied: true };
  }
  try { await keepwarmProbe(cfg, log, deps, ps); } catch (e) {
    log(`建立 standby 失败（现有注释条目仍是可用 standby，下一轮重试）: ${e.message}`);
  }
  return { action: "full", reason: "进入代理保活模式（条目已注释 + standby 就位）", block: null, stuck: [], proxied: true };
}

// 持续保活：节流的全量重测
async function proxyIdleKeepwarm(cfg, log, deps = {}, ps) {
  try {
    const wrote = await keepwarmProbe(cfg, log, deps, ps);
    return { action: "full", reason: wrote ? "代理保活：standby 已按直连重测刷新" : "代理保活：重测全灭，保留旧 standby", block: null, stuck: [], proxied: true };
  } catch (e) {
    log(`保活探测失败（保留旧 standby，下一轮重试）: ${e.message}`);
    return { action: "error", reason: `保活探测失败: ${e.message}`, offline: false, block: null, stuck: [], proxied: true };
  }
}

// 代理死亡：先转正 standby（无缝），再全量重测校准
async function proxyDeathRestore(cfg, log, deps = {}) {
  const hostsPath = deps.hostsPath || WIN_HOSTS;
  const readH = deps.readHosts || ((p) => fs.readFileSync(p, "utf8"));
  const apply = deps.applyHosts || applyHosts;
  try {
    const latest = readH(hostsPath);
    const cur = parseBlock(latest);
    if (cur.idle.size > 0) {
      const { entries, extras } = idleToActive(cur.idle);
      const block = buildHealthBlock(entries, cur.absent, extras, cur.blocked, cur.suspect, false);
      await apply(mergeHosts(latest, block), hostsPath);
      log(`保活条目已立即恢复（${entries.size} 个域名）—— 直连解析已就位，后台继续重测校准`);
    }
  } catch (e) {
    log(`保活条目恢复失败（将由全量重测兜底）: ${e.message}`);
  }
  try {
    const r = await (deps.runProbe || runProbe)(cfg, log, null);
    const block = blockFromProbeResult(cfg, r);
    const latest2 = readH(hostsPath);
    if (shouldKeepOldBlock(latest2, block)) {
      log("全量重测无可用 IP（全灭护栏），保留已恢复条目");
      return { action: "full", reason: "代理停止：已恢复保活条目（重测全灭，保留）", block: null, stuck: [] };
    }
    const merged = mergeHosts(latest2, block);
    if (merged !== latest2) {
      await apply(merged, hostsPath);
      log("全量重测校准完成");
    }
    return { action: "full", reason: "本地代理停止：保活条目已恢复并按直连重测校准", block, stuck: [] };
  } catch (e) {
    log(`重测校准失败（已恢复的条目仍有效，下一轮自愈继续）: ${e.message}`);
    return { action: "full", reason: "代理停止：已恢复保活条目（校准失败待重试）", block: null, stuck: [] };
  }
}

export async function daemonCycle(cfg, log, deps = {}) {
  // ghprobe off 后：不探测、不写 hosts。暂停检查必须放在最前 —— 连「断网跳过」都
  // 不能先判，off 语义是「先别动我的网络」，探测请求本身也不该发。
  // deps.isPaused 可注入（单测不碰真实用户目录）。
  if ((deps.isPaused || isPaused)()) {
    return { action: "skip", reason: "已暂停（ghprobe off 恢复）", offline: false, block: null, stuck: [] };
  }
  // 0.1.8 代理保活状态机。需要 deps.proxyState（runDaemon 注入的跨轮持久对象）：
  // 没有 proxyState 的一次性调用（单测/无状态路径）不碰代理逻辑 —— 一次性进程没有
  // 跨轮记忆，做不了跃迁判断；一次性路径的兜底由 runHealth 的 idle 分支负责。
  const ps = deps.proxyState;
  if (cfg.proxy?.enabled !== false && ps) {
    let pi = null;
    try { pi = await (deps.detectProxy || detectProxy)(cfg); } catch { pi = null; }
    const aliveNow = Boolean(pi && pi.found && pi.alive);
    const idleModeWanted = cfg.proxy?.idleMode !== false;
    if (ps.wasAlive === true && !aliveNow) {
      ps.wasAlive = false;
      log(`本地代理已停止（此前 ${ps.endpoint || "存活"}）→ 立即恢复保活条目并全量重测`);
      return proxyDeathRestore(cfg, log, deps);
    }
    if (aliveNow && idleModeWanted && (ps.wasAlive === false || ps.wasAlive === undefined)) {
      ps.wasAlive = true;
      if (pi && pi.found) { ps.endpoint = `${pi.host}:${pi.port}`; }
      return proxyIdleEnter(cfg, log, deps, ps);
    }
    ps.wasAlive = aliveNow;
    if (pi && pi.found) { ps.endpoint = `${pi.host}:${pi.port}`; }
    if (aliveNow && idleModeWanted) {
      // 持续保活：到点全量重测，未到点直接跳过（心跳照写，监督者不会误插手）
      const min = (cfg.proxy?.idleProbeMin ?? 5) * 60000;
      const age = ps.standbyAt ? Date.now() - ps.standbyAt : Infinity;
      if (age >= min) { return proxyIdleKeepwarm(cfg, log, deps, ps); }
      return {
        action: "none",
        reason: `代理保活中（${ps.endpoint || "proxy"}，下次保活探测约 ${Math.max(1, Math.ceil((min - age) / 60000))} 分钟后）`,
        offline: false, block: null, stuck: [], proxied: true,
      };
    }
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
  // 跨轮代理状态：真实 daemon 默认带一份（跃迁检测生效）；测试注入 null/自定义可关掉或接管
  const proxyState = deps.proxyState !== undefined ? deps.proxyState : {};
  const cycle = deps.cycle || ((c, l) => daemonCycle(c, l, {
    gate, applyHosts: deps.applyHosts, hostsPath: deps.hostsPath,
    proxyState, detectProxy: deps.detectProxy, runProbe: deps.runProbe, readHosts: deps.readHosts,
  }));
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
