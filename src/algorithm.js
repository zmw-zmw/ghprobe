// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 zmw
// algorithm：用户行为感知的「切换时机」决策（0.6.0）。
//
// 为什么需要：换 IP 不是零成本的 —— flushdns + 连接池重建，正在浏览的页面会卡一下，
// 进行中的下载/克隆可能断。0.5.0 及以前 daemon 只看网络健康，不看用户在干什么：
// 半夜优化切没事，用户正看 GitHub 文档时切就是「打扰」。
//
// 决策模型（成本 vs 紧急度）：
//   成本 = 前台是浏览器(100) > 浏览器在后台跑(30) > 前台是其他软件(10) > 空闲(0)，权重可配
//   紧急度 = 当前**已经不可用**的域名（主备全死）——这类修复**不吃权重，立即切**：
//            「正在用」和「不能用」二选一，当然选别断网。
//   非紧急（提上备选/重排优化/补写缺失/兜底写入）在前台浏览器时推迟，攒成待写块，
//   空闲时落地；推迟上限 deferMaxMs（默认 10 分钟）防饿死。
//
// 检测全部**免管理员**：tasklist 扫浏览器进程 + PowerShell GetForegroundWindow 查前台。
import { execFile } from "node:child_process";

// 常见浏览器进程名（小写、不带 .exe）。匹配 tasklist 镜像名与前台的 ProcessName。
export const DEFAULT_BROWSERS = [
  "chrome", "msedge", "firefox", "brave", "opera", "vivaldi", "360se", "360chrome",
  "qqbrowser", "sogouexplorer", "maxthon", "twinkstar", "hxbcrowser", "baidubrowser",
];

// 解析 tasklist /FO CSV /NH 输出 -> 小写进程名 Set（"chrome.exe","123",...）
export function parseTasklist(out) {
  const names = new Set();
  for (const line of String(out || "").split(/\r?\n/)) {
    const m = line.match(/^"([^"]+)"/);
    if (m) { names.add(m[1].toLowerCase().replace(/\.exe$/, "")); }
  }
  return names;
}

// 纯函数：进程名集合里有没有浏览器
export function browserRunningFrom(processNames, browsers) {
  return (browsers || []).some((b) => processNames.has(String(b).toLowerCase()));
}

// 活动检测（可注入 exec，测试不打真系统）：
//   running    = 浏览器进程存在（含后台标签页/更新进程 —— 它们同样会被 flushdns 影响）
//   foreground = 前台窗口是浏览器（用户正在看网页）
// PowerShell 查询失败按 foreground=false 处理（保守偏向「可以切」：打扰是体验问题，
// 断网是可用性问题，检测手段失败时不应把可用性押在一个尽力而为的信号上）。
export async function detectActivity(cfg, deps = {}) {
  const exec = deps.exec || execFile;
  const browsers = cfg.algorithm?.browsers || DEFAULT_BROWSERS;
  const platform = deps.platform || process.platform;
  if (platform !== "win32") { return { running: false, foreground: false, source: "non-win32" }; }

  const running = await new Promise((resolve) => {
    exec("tasklist", ["/FO", "CSV", "/NH"], { windowsHide: true, timeout: 5000 }, (e, stdout) => {
      if (e) { resolve(false); return; }
      resolve(browserRunningFrom(parseTasklist(stdout), browsers));
    });
  });

  const fgName = await new Promise((resolve) => {
    const ps = `Add-Type -MemberDefinition '[DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();[DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint p);' -Name FG -Namespace W; $h=[W.FG]::GetForegroundWindow(); $p=0; [W.FG]::GetWindowThreadProcessId($h, [ref]$p) | Out-Null; if ($p) { $pr = Get-Process -Id $p -ErrorAction SilentlyContinue; if ($pr) { Write-Output $pr.ProcessName.ToLower() } }`;
    exec("powershell", ["-NoProfile", "-Command", ps], { windowsHide: true, timeout: 6000 }, (e, stdout) => {
      resolve(e ? "" : String(stdout || "").trim().toLowerCase());
    });
  });

  return {
    running,
    foreground: running && browsers.includes(fgName),
    fgName,
    source: fgName ? "foreground-ok" : "foreground-unknown",
  };
}

// 成本权重（纯函数）
export function switchCost(activity, weights = {}) {
  const w = { browserForeground: 100, browserRunning: 30, otherForeground: 10, idle: 0, ...weights };
  if (activity.foreground) { return w.browserForeground; }
  if (activity.running) { return w.browserRunning; }
  if (activity.otherForeground) { return w.otherForeground; }
  return w.idle;
}

// 核心决策（纯函数）。
//   deadCount   = 当前主备全死的域名数 —— P0，不吃权重
//   initial     = 首次写入（hosts 里还没有块）—— 无从打扰，直接切
//   cost        = switchCost 结果
//   deferSinceMs/nowMs = 本次推迟的起点，超 deferMaxMs 强制切（防饿死）
export function decideSwitch({ cost = 0, deadCount = 0, initial = false, deferSinceMs = null, nowMs = Date.now(), cfg = {} }) {
  const a = cfg.algorithm || {};
  if (a.enabled === false) { return { switch: true, reason: "algorithm 已禁用" }; }
  if (deadCount > 0) { return { switch: true, reason: `紧急修复（当前不可用域名 ${deadCount} 个，用户正在受影响）` }; }
  if (initial) { return { switch: true, reason: "首次写入（无从打扰）" }; }
  if (deferSinceMs != null && nowMs - deferSinceMs >= (a.deferMaxMs ?? 600_000)) {
    return { switch: true, reason: "推迟已达上限，强制切换" };
  }
  const threshold = a.deferThreshold ?? 100;
  if (cost >= threshold) {
    return { switch: false, reason: `打扰成本 ${cost} >= 阈值 ${threshold}（用户正在用浏览器），攒到空闲再切` };
  }
  return { switch: true, reason: `打扰成本 ${cost} < 阈值 ${threshold}` };
}

// 门控：交给 runHealth 的 beforeApply 钩子 + daemon 的空闲落地（flush）。
// 内部状态跨轮存活：deferred 的块存 pendingBlock，用户空闲后由 maybeFlush 落地。
export function createSwitchGate(deps = {}) {
  const state = { pendingBlock: null, deferSinceMs: null };
  const detect = deps.detect || detectActivity;

  async function activityNow(cfg, { fresh = false } = {}) {
    // 检测结果短缓存：daemon 15~45s 一轮，PS + tasklist 各 ~0.3s，同轮内不重复打系统。
    // fresh=true 跳过缓存 —— 空闲落地是最终决策点，必须用此刻的真实状态
    // （用户可能刚离开浏览器；用几秒前的缓存会白白推迟一次）。
    const ttl = cfg.algorithm?.detectCacheMs ?? 20_000;
    const now = Date.now();
    if (!fresh && state.cache && now - state.cache.at < ttl) { return state.cache.activity; }
    const activity = await detect(cfg, deps);
    state.cache = { at: now, activity };
    return activity;
  }

  return {
    // runHealth 的 beforeApply 钩子：meta = { deadDomains, initial, changed, reason, block, cfg }
    async beforeApply(meta) {
      // P0 短路：用户此刻已经断着 / 首次写入 —— 不检测、不推迟，立即切。
      // 必须在活动检测之前 return，否则活动检测失败等噪声会把救命修复也拦下来。
      if ((meta.deadDomains || []).length > 0 || meta.initial) {
        state.lastReason = meta.initial ? "首次写入" : `紧急修复（不可用域名 ${meta.deadDomains.length} 个）`;
        return true;
      }
      const activity = await activityNow(meta.cfg || {});
      const cost = switchCost(activity, meta.cfg?.algorithm?.weights);
      const d2 = decideSwitch({
        cost,
        deadCount: 0,
        initial: false,
        deferSinceMs: state.deferSinceMs,
        nowMs: Date.now(),
        cfg: meta.cfg || {},
      });
      if (d2.switch) {
        state.pendingBlock = null;
        state.deferSinceMs = null;
        state.lastReason = d2.reason;
        return true;
      }
      state.pendingBlock = meta.block; // 攒着，空闲时落地
      state.deferSinceMs = state.deferSinceMs ?? Date.now();
      state.lastReason = d2.reason;
      return false;
    },
    // daemon 每轮调用：有待写块且此刻成本低 -> 落地
    async maybeFlush(cfg, log, deps2 = {}) {
      if (!state.pendingBlock) { return null; }
      const activity = await activityNow(cfg, { fresh: true });
      const cost = switchCost(activity, cfg?.algorithm?.weights);
      const d = decideSwitch({
        cost, deadCount: 0, initial: false,
        deferSinceMs: state.deferSinceMs, nowMs: Date.now(), cfg,
      });
      if (!d.switch) { return { flushed: false, reason: d.reason }; }
      const applyHosts = deps.applyHosts || deps2.applyHosts;
      const hostsPath = deps2?.hostsPath;
      const merged = deps2.mergeLatest(state.pendingBlock); // 调用方负责读最新 hosts 并合并（护栏在其中）
      await applyHosts(merged, hostsPath);
      const block = state.pendingBlock;
      state.pendingBlock = null;
      state.deferSinceMs = null;
      log(`空闲落地：打扰成本 ${cost}，已写入推迟的 hosts 块（${d.reason}）`);
      return { flushed: true, block };
    },
    get pending() { return Boolean(state.pendingBlock); },
    get lastReason() { return state.lastReason || ""; },
  };
}
