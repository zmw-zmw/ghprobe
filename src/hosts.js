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

function writePs1(script) {
  const tmp = path.join(os.tmpdir(), `ghprobe-${Date.now()}.ps1`);
  fs.writeFileSync(tmp, script, "utf8");
  return tmp;
}

function runElevated(ps1) {
  return new Promise((resolve, reject) => {
    // 用 Start-Process -Verb RunAs 弹 UAC 提权，-PassThru -Wait 取回被提升进程 ExitCode
    const cmd = `$p = Start-Process -FilePath powershell -Verb RunAs -Wait -PassThru -ArgumentList '-NoProfile','-ExecutionPolicy','Bypass','-File','${ps1}'; exit $p.ExitCode`;
    const child = execFile("powershell", ["-NoProfile", "-Command", cmd], { windowsVerbatimArguments: true });
    let out = "";
    let err = "";
    child.stdout?.on("data", (d) => { out += d; });
    child.stderr?.on("data", (d) => { err += d; });
    child.on("close", (code) => {
      try { fs.unlinkSync(ps1); } catch { /* 清理失败不管 */ }
      resolve({ code, out, err });
    });
    child.on("error", (e) => {
      try { fs.unlinkSync(ps1); } catch { /* 清理失败不管 */ }
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
  const ps1 = writePs1(script);
  const r = await runElevated(ps1);
  if (r.code !== 0) { throw new Error(`提权写入失败: ${r.err || r.out}`); }
  return { ok: true, backup: bak };
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
  const ps1 = writePs1(script);
  const r = await runElevated(ps1);
  if (r.code !== 0) { throw new Error(`还原 hosts 失败: ${r.err || r.out}`); }
  return { ok: true };
}
