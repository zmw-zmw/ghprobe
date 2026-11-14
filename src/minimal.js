// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 zmw
// 主站模式（0.1.13 反运营商批次）：只加速 GitHub 主站，其余域名全部不管。
// 动机（2026-11-14 实战）：githubusercontent 家族被运营商精准黑洞 —— .133 四连 TCP 全死，
// 而全网 DNS（DoH/UDP 多源实测）对它只返回这 4 个 IP，没有任何备用候选；跟踪它们只会
// 持续产生 stuck 噪音与无效境外连接。「只保能用的，不追救不活的」。
// 写入：domains = [github.com, github.githubassets.com] —— 🔴 assets 必须带上：
// 主站页面的全部 CSS/JS/字体都从 github.githubassets.com 加载，不跟踪它主站照样又慢又裂
// （2026-11-14 用户反馈「反而变慢」的教训）。除这两者外一概不管。
// 兜底域名不用清 —— targetDomains 已改为「兜底只跟随被跟踪的主域名」，raw 不在
// domains 里时 jsdelivr 三条自动不再进探测/orphan 名单。
// off = 删键回落：domains 回到默认 9 域名，兜底链随主域名恢复。
import { readUserConfig, writeUserConfig } from "./config.js";
import { setPath, delPath } from "./lowkey.js";

export { readUserConfig, writeUserConfig };

// 预设会写哪些键（off 时按此删）
export const MINIMAL_PATHS = ["domains", "minimal"];

// 主站最小域名集：HTML 本体 + 页面静态资源
export const MINIMAL_DOMAINS = ["github.com", "github.githubassets.com"];

// on：domains 收敛 + 落状态标记。纯函数，返回新对象；用户其它键原样保留。
export function applyMinimal(user, now = new Date().toISOString()) {
  const out = structuredClone(user || {});
  setPath(out, "domains", [...MINIMAL_DOMAINS]);
  setPath(out, "minimal", { enabled: true, at: now });
  return out;
}

// off：删除预设写入的键（domains/fallbacks/minimal），回落跟随默认。纯函数。
export function removeMinimal(user) {
  const out = structuredClone(user || {});
  for (const p of MINIMAL_PATHS) { delPath(out, p); }
  return out;
}

export function isMinimal(user) {
  return Boolean(user && user.minimal && user.minimal.enabled);
}
