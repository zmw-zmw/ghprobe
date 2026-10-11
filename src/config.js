// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 zmw
// 配置加载：包内默认 YAML + 用户覆盖（对象递归合并：顶层用户键覆盖默认键，对象属性合并而非整体替换）
// 用户配置放在用户数据目录（%LOCALAPPDATA%\ghprobe\config.yaml），install 时自动生成一份，
// 用户可自由编辑 —— 放在包目录会被 npm 升级/重装整个换掉。
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import yaml from "js-yaml";
import { userDataDir } from "./hosts.js";
import { readPoolCache } from "./pool.js";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

// 用户可编辑的配置文件路径（install 时生成；不存在也不报错）
export function userConfigPath() {
  return path.join(userDataDir(), "config.yaml");
}

// 「安装时的默认配置」快照路径。它的唯一用途：**判断用户到底改过哪些键**。
// 为什么需要：用户配置是 install 时整份复制的，而用户配置优先于包内默认 ——
// 于是**默认文件里已有键的新默认值，永远到不了老用户**（数组是整体替换，不合并）。
// 有了快照就能做三方合并：用户值 == 快照值 → 他没动过这个键 → 用**新默认**。
export function userConfigSnapshotPath() {
  return path.join(userDataDir(), "config.default.snapshot.yaml");
}

function isPlainObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v) && !(v instanceof Date) && !(v instanceof RegExp);
}

// 读 YAML，读不到/解析失败都返回 null（不抛）
function readYamlSafe(p) {
  try { return yaml.load(fs.readFileSync(p, "utf8")); } catch { return null; }
}

// 深比较（只看结构，不看键顺序）—— 三方合并要靠它判断「用户值是否还等于安装时的默认值」
export function deepEqual(a, b) {
  if (a === b) { return true; }
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) { return false; }
    return a.every((x, i) => deepEqual(x, b[i]));
  }
  if (isPlainObject(a) || isPlainObject(b)) {
    if (!isPlainObject(a) || !isPlainObject(b)) { return false; }
    const ka = Object.keys(a);
    if (ka.length !== Object.keys(b).length) { return false; }
    return ka.every((k) => Object.prototype.hasOwnProperty.call(b, k) && deepEqual(a[k], b[k]));
  }
  return false;
}

function mergeDefaults(def, user) {
  if (!isPlainObject(def) || !isPlainObject(user)) { return user === undefined ? def : user; }
  const out = { ...def };
  for (const key of Object.keys(user)) {
    out[key] = isPlainObject(def[key]) && isPlainObject(user[key]) ? mergeDefaults(def[key], user[key]) : user[key];
  }
  return out;
}

// 三方合并：def = 当前包内默认，user = 用户配置，snap = 安装时的默认快照。
//   用户值 == 快照值  -> 这个键用户没动过 -> 用**当前默认**（默认值的改进能自动到达老用户）
//   用户值 != 快照值  -> 用户改过 -> 保留用户值
//   快照里没有这个键   -> 用户自己加的 -> 保留
//   默认里有、用户没有 -> 新键 -> 直接用默认（同 mergeDefaults）
// 🔴 没有快照时（0.1.2 之前装的）**不敢猜**，退回「用户值优先」的老行为 —— 判断不了就别动用户的值。
export function mergeThreeWay(def, user, snap) {
  if (!snap) { return mergeDefaults(def, user); }
  if (!isPlainObject(user)) { return user; }
  const out = { ...(isPlainObject(def) ? def : {}) };
  for (const k of Object.keys(user)) {
    const d = isPlainObject(def) ? def[k] : undefined;
    const u = user[k];
    const hasSnap = isPlainObject(snap) && Object.prototype.hasOwnProperty.call(snap, k);
    if (!hasSnap) { out[k] = u; continue; }
    if (isPlainObject(u) && isPlainObject(snap[k])) { out[k] = mergeThreeWay(d ?? {}, u, snap[k]); continue; }
    out[k] = deepEqual(u, snap[k]) ? (d === undefined ? u : d) : u;
  }
  return out;
}

// 用户配置与当前默认的差异（供 `ghprobe config-diff` 用）。
// 对老用户来说，他配置里的值**全部**来自旧版默认 —— 所以任何差异都是「你可能想采纳的默认改动」。
export function configDiff() {
  const def = readYamlSafe(path.join(ROOT, "config.default.yaml"));
  const user = readYamlSafe(userConfigPath());
  if (!user) { return { hasUser: false, diff: [] }; }
  const out = [];
  const walk = (d, u, prefix) => {
    const keys = new Set([...Object.keys(d || {}), ...Object.keys(u || {})]);
    for (const k of keys) {
      const path0 = prefix ? `${prefix}.${k}` : k;
      const dv = isPlainObject(d) ? d[k] : undefined;
      const uv = isPlainObject(u) ? u[k] : undefined;
      if (isPlainObject(dv) && isPlainObject(uv)) { walk(dv, uv, path0); continue; }
      if (!deepEqual(dv, uv)) { out.push({ key: path0, user: uv, def: dv }); }
    }
  };
  walk(def, user, "");
  return { hasUser: true, diff: out };
}

// 把「自动更新的池缓存」并进 ipPools.auto（池名固定为 auto，供 domainPools 引用）。
// 缓存不存在时什么都不做 —— 探测侧对缺失的池名是宽容的（会退回「用全部池」）。
function withPoolCache(cfg) {
  const cache = readPoolCache();
  if (cache && Array.isArray(cache.ips) && cache.ips.length) {
    cfg.ipPools = { ...(cfg.ipPools || {}), auto: cache.ips };
  }
  return cfg;
}

// fallbacks 归一化：既支持简写 `[域名]`，也支持完整写法 `[{ domain, path, mustContain }]`。
// 归一化后：
//   cfg.fallbacks    = { 主域名: [替身域名...] }          —— 下游（targetDomains / neededFallbacks）不用改
//   cfg.fallbackSigs = { 替身域名: { path, mustContain } } —— 供 prober 用该替身自己的探测判据
//
// 🔴 为什么需要：兜底域名本身也可能被封（实测 2026-10-11：`cdn.jsdelivr.net` 在当前网络下
//    TCP 连得上但 TLS 被掐），所以配置里要给**多个候选**、探测时挑当下能通的那个。
//    而不同替身服务的 URL 形态不同 —— CDN 映射是 `/gh/<user>/<repo>@<ref>/<path>`，
//    代理是 `/<完整原始 URL>` —— 判据没法写死在代码里，必须跟着配置走。
export function normalizeFallbacks(cfg) {
  const raw = cfg.fallbacks || {};
  const fallbacks = {};
  const fallbackSigs = {};
  for (const [primary, list] of Object.entries(raw)) {
    const domains = [];
    for (const item of (Array.isArray(list) ? list : [])) {
      if (typeof item === "string") { domains.push(item); continue; }
      if (item && typeof item === "object" && item.domain) {
        domains.push(item.domain);
        const sig = {};
        if (item.path) { sig.path = item.path; }
        if (Array.isArray(item.mustContain) && item.mustContain.length) { sig.mustContain = item.mustContain; }
        if (Object.keys(sig).length) { fallbackSigs[item.domain] = sig; }
      }
    }
    fallbacks[primary] = domains;
  }
  cfg.fallbacks = fallbacks;
  cfg.fallbackSigs = fallbackSigs;
  return cfg;
}

// 优先级：--config 显式指定 > 用户目录 config.yaml > 包内 config.default.yaml
// 用户目录那份走**三方合并**（见 mergeThreeWay）：用户没改过的键会跟随最新默认值。
export function loadConfig(userPath) {
  const def = yaml.load(fs.readFileSync(path.join(ROOT, "config.default.yaml"), "utf8"));
  let user = null;
  for (const p of [userPath, userConfigPath()]) {
    if (!p) { continue; }
    const y = readYamlSafe(p);
    if (y) { user = y; break; }
  }
  if (!user) { return withPoolCache(normalizeFallbacks(def)); }
  const snap = readYamlSafe(userConfigSnapshotPath());
  return withPoolCache(normalizeFallbacks(mergeThreeWay(def, user, snap)));
}

// 首次 install 时把包内默认配置复制成用户配置（已存在则不覆盖，保留用户改动）；
// 快照缺失时补一份（= 当前默认），供三方合并判断「用户改过哪些键」。
// ⚠️ 快照**只在缺失时创建，不随升级刷新** —— 它代表「用户拿到配置时默认长什么样」这个基准，
//    一刷新基准就漂了，用户没改过的键也会被误判成改过。
export function ensureUserConfig() {
  const p = userConfigPath();
  const defPath = path.join(ROOT, "config.default.yaml");
  try {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    if (!fs.existsSync(p)) { fs.copyFileSync(defPath, p); }
    const snap = userConfigSnapshotPath();
    if (!fs.existsSync(snap)) { fs.copyFileSync(defPath, snap); }
  } catch { /* 写不了不阻塞安装 */ }
  return p;
}
