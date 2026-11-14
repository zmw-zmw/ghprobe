// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 zmw
// 低调模式（0.1.13 反运营商）：一键写入/移除「被运营商按境外连接画像制裁」的缓解配置。
// 命令化的是 docs/guide-isp.md 手册里的手动步骤 —— 预设全部来自真机两周生产验证：
//   - DoH 只留**证书带 IP SAN 的 5 条**端点并删除 sni 字段（SNI 阻断逃生门：不发 SNI、
//     证书按 IP SAN 校验，DNS 层对 SNI 阻断免疫）
//   - UDP 补充源收敛 3 -> 2 条（114 / DNSPod）
//   - 候选 8->4、池 32->12、并发 10->4（对外握手扇出降到 1/3 以下）
//   - 健康态间隔 90s->120s、保活探测 5min->10min
// 实现纪律：
//   - 只写用户配置（%LOCALAPPDATA%\ghprobe\config.yaml），**不碰包内默认** —— 开源默认值
//     必须中性（规则：默认文件里已有 UA 中性化/全灭退避这类无感缓解；本预设是更激进的
//     个人取舍，写进默认会替所有用户做决定）
//   - off = **删除**预设写入的键：三方合并语义下「用户配置里没有的键」自动跟随最新默认，
//     未来默认值的改进继续到达 —— 比把快照值抄回来钉死更好
//   - 写回用 js-yaml dump，注释会丢（三方合并只看键值，无影响）；lowkey.enabled 是状态标记
import fs from "node:fs";
import path from "node:path";
import yaml from "js-yaml";
import { userConfigPath } from "./config.js";

// 无 SNI DoH 端点：实测证书带 IP SAN 的 5/7 条（111.7.73.60 / 39.156.84.71 证书不含 IP SAN，不入选）
const LOWKEY_DOH = [
  { name: "alidns1", host: "223.5.5.5", path: "/dns-query" },
  { name: "alidns2", host: "223.6.6.6", path: "/dns-query" },
  { name: "dnspod", host: "1.12.12.12", path: "/dns-query" },
  { name: "dnspod2", host: "120.53.53.53", path: "/dns-query" },
  { name: "dns360", host: "221.181.72.233", path: "/dns-query" },
];

// 预设本体（键名与 config.default.yaml 一致）
export function lowkeyPreset() {
  return {
    doh: LOWKEY_DOH.map((e) => ({ ...e })),
    dohUdp: { enabled: true, servers: ["114.114.114.114", "119.29.29.29"], timeoutMs: 2000 },
    probe: { maxCandidates: 4, maxPoolIps: 12, concurrency: 4 },
    schedule: { daemonHealthyMs: 120_000 },
    proxy: { idleProbeMin: 10 },
  };
}

// 预设会写哪些键（off 时按此删）：不带点 = 顶层整键；带点 = 只删该子键（用户自有覆盖保留）
export const LOWKEY_PATHS = [
  "doh", "dohUdp", "probe.maxCandidates", "probe.maxPoolIps", "probe.concurrency",
  "schedule.daemonHealthyMs", "proxy.idleProbeMin", "lowkey",
];

function setPath(obj, path0, value) {
  const seg = path0.split(".");
  let cur = obj;
  for (let i = 0; i < seg.length - 1; i++) {
    if (cur[seg[i]] === null || typeof cur[seg[i]] !== "object") { cur[seg[i]] = {}; }
    cur = cur[seg[i]];
  }
  cur[seg[seg.length - 1]] = value;
}

function delPath(obj, path0) {
  const seg = path0.split(".");
  let cur = obj;
  for (let i = 0; i < seg.length - 1; i++) {
    if (cur === null || typeof cur !== "object" || !(seg[i] in cur)) { return; }
    cur = cur[seg[i]];
  }
  delete cur[seg[seg.length - 1]];
  // 空壳清理：预设只写了这个父键下的子键且现在空了，父键也删（避免留 {} 噪音）
  if (seg.length > 1) {
    let p = obj;
    for (let i = 0; i < seg.length - 2; i++) { p = p[seg[i]]; }
    const parent = p[seg[seg.length - 2]];
    if (parent !== null && typeof parent === "object" && Object.keys(parent).length === 0) {
      delete p[seg[seg.length - 2]];
    }
  }
}

// on：把预设并入用户配置 + 落状态标记。纯函数，返回新对象。
// 🔴 对象键（probe/schedule/proxy/dohUdp）必须**子键合并**而不是整键替换 ——
//    用户可能有自己的覆盖（如 schannelRetry/userAgent），整键替换会把它们吞掉；
//    预设子键赢（这是 lowkey 的语义），用户其它子键原样保留。
function isPlainObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

export function applyLowkey(user, now = new Date().toISOString()) {
  const out = structuredClone(user || {});
  for (const [k, v] of Object.entries(lowkeyPreset())) {
    out[k] = isPlainObject(v) && isPlainObject(out[k])
      ? { ...structuredClone(out[k]), ...structuredClone(v) }
      : structuredClone(v);
  }
  out.lowkey = { enabled: true, at: now };
  return out;
}

// off：删除预设写入的所有键 + 标记；用户自有覆盖与非相关键原样保留。纯函数。
export function removeLowkey(user) {
  const out = structuredClone(user || {});
  for (const p of LOWKEY_PATHS) { delPath(out, p); }
  return out;
}

export function isLowkey(user) {
  return Boolean(user && user.lowkey && user.lowkey.enabled);
}

export function readUserConfig() {
  try { return yaml.load(fs.readFileSync(userConfigPath(), "utf8")); } catch { return null; }
}

export function writeUserConfig(obj) {
  const p = userConfigPath();
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, yaml.dump(obj, { lineWidth: 120 }), "utf8");
  return p;
}
