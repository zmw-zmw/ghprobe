// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 zmw
// 本地网络可用性检查：本机断网时直接跳过本轮 —— 不探测、不更新池、不写 hosts。
// 为什么需要：断网时所有候选必然全灭，跑一轮纯属浪费，而且日志会被「stuck / 全灭」刷屏，
// 掩盖真正的故障；更糟的是会让「网络故障」和「GitHub 被墙」两种情况混在一起无法区分。
import os from "node:os";
import net from "node:net";

// 第一步（零成本）：有没有「已启用且带非回环 IPv4」的网卡。
// 只能排除「网卡全禁用 / 只连了回环」这种最明显的情况，不能证明真能出去。
export function hasInterface() {
  const ifs = os.networkInterfaces();
  for (const list of Object.values(ifs)) {
    for (const a of list || []) {
      if (!a.internal && (a.family === "IPv4" || a.family === 4)) { return true; }
    }
  }
  return false;
}

// 第二步：TCP 连一下基准目标。只判断「本机能不能出去」，与 GitHub 是否可达无关 ——
// 后者交给正常探测（换 IP 能救的属于 GitHub 侧，不在这里判）。
export function canReach(host, port, timeoutMs) {
  return new Promise((resolve) => {
    const sock = net.connect({ host, port });
    let done = false;
    const fin = (ok) => {
      if (done) { return; }
      done = true;
      try { sock.destroy(); } catch { /* 忽略 */ }
      resolve(ok);
    };
    sock.setTimeout(timeoutMs, () => fin(false));
    sock.on("connect", () => fin(true));
    sock.on("error", () => fin(false));
  });
}

// 基准目标默认用阿里公共 DNS 的 DoH 端点（223.5.5.5:443）：
// 国内任何正常网络都该能连上，且它不是 GitHub —— 不会被 SNI 封锁影响判断。
export async function hasLocalNetwork(cfg) {
  const c = cfg.networkCheck || {};
  if (c.enabled === false) { return true; }
  if (!hasInterface()) { return false; }
  const p = c.probe || {};
  return canReach(p.host || "223.5.5.5", p.port ?? 443, p.timeoutMs ?? 2000);
}
