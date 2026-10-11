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

function isPlainObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v) && !(v instanceof Date) && !(v instanceof RegExp);
}

function mergeDefaults(def, user) {
  if (!isPlainObject(def) || !isPlainObject(user)) { return user === undefined ? def : user; }
  const out = { ...def };
  for (const key of Object.keys(user)) {
    out[key] = isPlainObject(def[key]) && isPlainObject(user[key]) ? mergeDefaults(def[key], user[key]) : user[key];
  }
  return out;
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
export function loadConfig(userPath) {
  const def = yaml.load(fs.readFileSync(path.join(ROOT, "config.default.yaml"), "utf8"));
  let user = null;
  for (const p of [userPath, userConfigPath()]) {
    if (!p) { continue; }
    try { user = yaml.load(fs.readFileSync(p, "utf8")); break; } catch { /* 不存在 / 读不了 -> 下一个 */ }
  }
  return withPoolCache(normalizeFallbacks(user ? mergeDefaults(def, user) : def));
}

// 首次 install 时把包内默认配置复制成用户配置（已存在则不覆盖，保留用户改动）
export function ensureUserConfig() {
  const p = userConfigPath();
  try {
    if (!fs.existsSync(p)) {
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.copyFileSync(path.join(ROOT, "config.default.yaml"), p);
    }
  } catch { /* 写不了不阻塞安装 */ }
  return p;
}
