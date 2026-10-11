// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 zmw
// hosts 片段生成 + 事务化提权写入 + 还原 + DNS 缓存刷新
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";

export const WIN_HOSTS = "C:\\Windows\\System32\\drivers\\etc\\hosts";
const BEGIN = "# === ghprobe begin ===";
const END = "# === ghprobe end ===";

// 写 hosts 跨进程锁：probe --apply 与计划任务（health --apply）可能并发，避免读改写互踩
export const HOSTS_LOCK = path.join(os.tmpdir(), "ghprobe-hosts.lock");
const LOCK_STALE_MS = 60000;

function sleepSync(ms) {
  const sab = new SharedArrayBuffer(4);
  Atomics.wait(new Int32Array(sab), 0, 0, ms);
}

// 抢写锁：wx 独占创建，冲突每 retryMs 重试，最多 timeoutMs；超时返回 null 表示本轮放弃。
// 锁文件带随机 PID+时间戳；超出 LOCK_STALE_MS 视为持有进程崩溃残留，强清后重试。
export function acquireHostsLock(timeoutMs = 5000, retryMs = 200) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const fd = fs.openSync(HOSTS_LOCK, "wx");
      fs.writeSync(fd, `${process.pid} ${Date.now()}\n`);
      return fd;
    } catch (e) {
      if (e.code !== "EEXIST") { throw e; }
      try {
        const st = fs.statSync(HOSTS_LOCK);
        if (Date.now() - st.mtimeMs > LOCK_STALE_MS) { fs.unlinkSync(HOSTS_LOCK); continue; }
      } catch { continue; } // 锁刚被持有者释放
    }
    if (Date.now() >= deadline) { return null; }
    sleepSync(retryMs);
  }
}

export function releaseHostsLock(fd) {
  try { if (fd != null) { fs.closeSync(fd); } } catch { /* 忽略 */ }
  try { fs.unlinkSync(HOSTS_LOCK); } catch { /* 忽略 */ }
}

// 从 ranked(域名->有序IP列表) 生成 hosts 块；Windows 同一域名只取第一条生效，故每域名仅写最优 1 条
export function buildBlock(ranked, extraDomains) {
  const lines = [BEGIN, `# generated ${new Date().toISOString()} by ghprobe`];
  for (const [domain, rs] of ranked) {
    if (rs.length) { lines.push(`${rs[0].ip} ${domain}`); }
  }
  for (const [domain, rs] of extraDomains || []) {
    if (rs.length) { lines.push(`${rs[0].ip} ${domain}`); }
  }
  lines.push(END);
  return lines.join("\n");
}

// 把新块合并进已有 hosts 内容：替换旧 ghprobe 块，其余行原样保留
export function mergeHosts(current, block) {
  const lines = String(current).split(/\r?\n/);
  const out = [];
  let inBlock = false;
  for (const line of lines) {
    if (line.startsWith(BEGIN)) { inBlock = true; continue; }
    if (line.startsWith(END)) { inBlock = false; continue; }
    if (!inBlock) { out.push(line); }
  }
  while (out.length && out[out.length - 1].trim() === "") { out.pop(); }
  if (!block) { return out.join("\n") + (out.length ? "\n" : ""); }
  const merged = [...out, "", block].join("\n");
  return merged.endsWith("\n") ? merged : merged + "\n";
}

// 写临时 ps1 -> 弹 UAC 提权执行 -> 取回被提升进程 ExitCode -> 清理 ps1（apply/restore/install 复用）
export async function runElevated(content) {
  const tmp = path.join(os.tmpdir(), `ghprobe-${Date.now()}.ps1`);
  fs.writeFileSync(tmp, content, "utf8");
  return new Promise((resolve, reject) => {
    // 用 Start-Process -Verb RunAs 弹 UAC 提权，-PassThru -Wait 取回被提升进程 ExitCode
    const cmd = `$p = Start-Process -FilePath powershell -Verb RunAs -Wait -PassThru -ArgumentList '-NoProfile','-ExecutionPolicy','Bypass','-File','${tmp}'; exit $p.ExitCode`;
    const child = execFile("powershell", ["-NoProfile", "-Command", cmd], { windowsVerbatimArguments: true });
    let out = "";
    let err = "";
    child.stdout?.on("data", (d) => { out += d; });
    child.stderr?.on("data", (d) => { err += d; });
    child.on("close", (code) => {
      try { fs.unlinkSync(tmp); } catch { /* 清理失败不管 */ }
      resolve({ code, out, err });
    });
    child.on("error", (e) => {
      try { fs.unlinkSync(tmp); } catch { /* 清理失败不管 */ }
      reject(e);
    });
  });
}

// 事务化提权写入：备份 -> 覆盖 -> 校验含 BEGIN -> 失败回滚 -> 刷 DNS 缓存
export async function applyHosts(merged, hostsPath = WIN_HOSTS) {
  const tmp = path.join(os.tmpdir(), `ghprobe-hosts-${Date.now()}.tmp`);
  fs.writeFileSync(tmp, merged, "utf8");
  const bak = `${hostsPath}.ghprobe-bak`;
  const script = `
$src = '${hostsPath}'
$tmp = '${tmp}'
$bak = '${bak}'
$marker = '${BEGIN}'
try {
  if (-not (Test-Path $bak)) { Copy-Item -Force $src $bak }
  Copy-Item -Force $tmp $src
  $now = Get-Content $src -Raw -ErrorAction Stop
  if ($now -notmatch [regex]::Escape($marker)) {
    Copy-Item -Force $bak $src
    Write-Error 'hosts 校验失败：未找到 ghprobe 标记，已回滚'
    exit 1
  }
  ipconfig /flushdns | Out-Null
  exit 0
} catch {
  if (Test-Path $bak) { Copy-Item -Force $bak $src }
  Write-Error $_
  exit 1
}
`;
  try {
    const r = await runElevated(script);
    if (r.code !== 0) { throw new Error(`提权写入失败: ${r.err || r.out}`); }
    return { ok: true, backup: bak };
  } finally {
    try { fs.unlinkSync(tmp); } catch { /* 清理失败不管 */ }
  }
}

// 还原 hosts：优先用备份恢复；无备份则移除 ghprobe 块后写回；最后刷 DNS 缓存
export async function restoreHosts(hostsPath = WIN_HOSTS) {
  const bak = `${hostsPath}.ghprobe-bak`;
  const script = `
$src = '${hostsPath}'
$bak = '${bak}'
try {
  if (Test-Path $bak) {
    Copy-Item -Force $bak $src
  } else {
    $current = Get-Content $src -Raw -ErrorAction Stop
    $clean = ($current -split '\r?\n' | Where-Object { $_ -notmatch '^# === ghprobe (begin|end) ===' }) -join "\n"
    [IO.File]::WriteAllText($src, $clean.TrimEnd() + "\n")
  }
  ipconfig /flushdns | Out-Null
  exit 0
} catch {
  Write-Error $_
  exit 1
}
`;
  const r = await runElevated(script);
  if (r.code !== 0) { throw new Error(`还原 hosts 失败: ${r.err || r.out}`); }
  return { ok: true };
}
