// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 zmw
// 更新检查（0.1.6）：npm 全局包不会自动升级，用户停在旧版本就吃不到自愈能力与新候选池
// 的改进 —— 而我们无从得知谁在用旧版。这里只做一件事：交互命令开头查一次 npm 上的
// latest，有新版就提示一行 `npm i -g ghprobe`。只提示，绝不自动升级（升级是用户的决定）。
//
// 纪律：
//   · 每天最多拉一次（缓存 24h），且只在**交互命令**里查 —— daemon / 计划任务静默路径
//     绝不联网查版本，不能为提示增长每隔几十秒打一次 registry。
//   · 查询源优先 npmmirror（国内网络可达性远好于 registry.npmjs.org），失败再试官方源。
//   · 任何失败都静默 —— 提示功能本身不许打扰用户，更不许影响命令退出码。
import fs from "node:fs";
import path from "node:path";
import { userDataDir } from "./hosts.js";

const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 5000;

export function updateCheckPath(dir = userDataDir()) {
  return path.join(dir, "update.check.json");
}

// 语义化版本比较：只认 x.y.z 纯数字段（v 前缀容忍）；带 prerelease / 解析不动的输入
// 一律返回 false（宁可漏提示，不误报）。
export function isNewer(latest, current) {
  const parts = (v) => String(v || "").trim().replace(/^v/i, "").split(".").map((x) => parseInt(x, 10));
  const a = parts(latest);
  const b = parts(current);
  if (a.length !== 3 || b.length !== 3 || a.some(Number.isNaN) || b.some(Number.isNaN)) { return false; }
  for (let i = 0; i < 3; i += 1) {
    if (a[i] !== b[i]) { return a[i] > b[i]; }
  }
  return false;
}

// 拉 latest：npmmirror 优先（国内可达），官方源兜底。5s 超时，全败返回 null。
async function fetchLatest(fetchImpl, pkgName) {
  for (const url of [`https://registry.npmmirror.com/${pkgName}/latest`, `https://registry.npmjs.org/${pkgName}/latest`]) {
    try {
      const r = await fetchImpl(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
      if (!r || !r.ok) { continue; }
      const o = await r.json();
      if (o && typeof o.version === "string" && o.version) { return o.version; }
    } catch { /* 换下一个源 */ }
  }
  return null;
}

// 查最新版本并写缓存。deps 全可注入（fetchImpl / now / cachePath / pkgName）供单测。
export async function checkUpdate(deps = {}) {
  const now = deps.now ?? Date.now();
  const file = deps.cachePath ?? updateCheckPath();
  const pkgName = deps.pkgName ?? "ghprobe";
  let cache = null;
  try { cache = JSON.parse(fs.readFileSync(file, "utf8")); } catch { /* 无缓存/坏缓存 */ }
  if (cache && Number.isFinite(cache.at) && cache.latest && now - cache.at >= 0 && now - cache.at < CHECK_INTERVAL_MS) {
    return { latest: cache.latest, cached: true };
  }
  const latest = await fetchLatest(deps.fetchImpl || fetch, pkgName);
  if (latest) {
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, JSON.stringify({ at: now, latest }));
    } catch { /* 缓存写失败不影响本次提示 */ }
  }
  return { latest, cached: false };
}

// 交互命令开头调一下：有新版打印一行提示；任何失败静默。
export async function maybeNotifyUpdate(current, log = console.log, deps = {}) {
  try {
    const { latest } = await checkUpdate(deps);
    if (latest && isNewer(latest, current)) {
      log(`提示：ghprobe ${latest} 已发布，建议升级 —— npm i -g ghprobe（当前 ${current}）`);
    }
  } catch { /* 更新检查失败不打扰 */ }
}
