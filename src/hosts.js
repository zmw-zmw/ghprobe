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

// 构造提权包装命令：Start-Process -Verb RunAs 拉起目标，并把被提升进程的退出码带回来。
// 两个关键点（都踩过）：
// ① 先把控制台输出编码设为 UTF-8 —— 否则 PowerShell 以 GBK 写 stderr，Node 按 UTF-8 解码会乱码，
//    调用方 throw 出来的「提权写入失败: …」就变成一串问号。
// ② 必须在 `exit $p.ExitCode` 之前判空：Start-Process 自身失败（典型是用户取消 UAC）时
//    抛的是「非终止错误」，脚本会继续往下执行，$p 仍为 $null，而 `exit $null` 等价于
//    退出码 0 —— 会把「提权失败」伪装成「成功」。-ErrorAction Stop 让它变成可捕获的终止错误。
export function buildElevateCommand(file, args = []) {
  const list = args.map((a) => `'${a}'`).join(",");
  return `try { [Console]::OutputEncoding = [Text.Encoding]::UTF8 } catch {};`
    + ` try { $p = Start-Process -FilePath '${file}' -Verb RunAs -Wait -PassThru -ArgumentList ${list} -ErrorAction Stop }`
    + ` catch { [Console]::Error.WriteLine('提权失败: ' + $_.Exception.Message); exit 1 };`
    + ` if ($null -eq $p) { exit 1 };`
    + ` exit $p.ExitCode`;
}

// 构造「删除计划任务」的提权脚本。单独导出是为了可单测、可独立执行验证。
// 两个关键点：
// ① 任务不存在时直接 exit 0（幂等）—— uninstall 重复跑不应报错。
// ② 删除动作必须 -ErrorAction Stop：否则「拒绝访问」这类错误是非终止的，脚本会继续走到
//    末尾的 exit 0，把「删除失败」伪装成「成功」。
export function buildUninstallTaskScript(taskName = "ghprobe") {
  return `try { [Console]::OutputEncoding = [Text.Encoding]::UTF8 } catch {};`
    + ` if (-not (Get-ScheduledTask -TaskName '${taskName}' -ErrorAction SilentlyContinue))`
    + ` { [Console]::Error.WriteLine('计划任务 ${taskName} 不存在，跳过'); exit 0 };`
    + ` try { Unregister-ScheduledTask -TaskName '${taskName}' -Confirm:$false -ErrorAction Stop }`
    + ` catch { [Console]::Error.WriteLine('删除计划任务失败: ' + $_.Exception.Message); exit 1 };`
    + ` exit 0`;
}

// 跑一段 PowerShell 命令，回传 { code, out, err }
function runPowerShellCommand(cmd) {
  return new Promise((resolve, reject) => {
    const child = execFile("powershell", ["-NoProfile", "-Command", cmd], { windowsVerbatimArguments: true });
    let out = "";
    let err = "";
    child.stdout?.on("data", (d) => { out += d; });
    child.stderr?.on("data", (d) => { err += d; });
    child.on("close", (code) => resolve({ code, out, err }));
    child.on("error", reject);
  });
}

// 跑一次提权包装。单独导出是为了让回归测试能注入一个必然失败的 Start-Process 目标，
// 从而验证「提权失败不会退化成退出码 0」。
export function runElevationWrapper(file, args = []) {
  return runPowerShellCommand(buildElevateCommand(file, args));
}

// 写提权脚本文件。🔴 必须带 UTF-8 BOM：PowerShell 5.1 对「无 BOM 的 .ps1」按系统 ANSI
// 代码页（中文系统 = GBK）解析，脚本里的中文字面量（错误提示）会整段变乱码。
// 加 BOM 后 PS 才按 UTF-8 解析。注意这条路径与 buildElevateCommand 不同 ——
// 那条走 `-Command`，参数由 CreateProcessW 以 UTF-16 传递，本来就不受文件编码影响。
export function writePs1WithBom(file, content) {
  fs.writeFileSync(file, "\ufeff" + content, "utf8");
}

// 写临时 ps1 -> 弹 UAC 提权执行 -> 取回被提升进程 ExitCode -> 清理 ps1（apply/restore/install 复用）
export async function runElevated(content) {
  const tmp = path.join(os.tmpdir(), `ghprobe-${Date.now()}.ps1`);
  writePs1WithBom(tmp, content);
  try {
    return await runElevationWrapper("powershell", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", tmp]);
  } finally {
    try { fs.unlinkSync(tmp); } catch { /* 清理失败不管 */ }
  }
}

// 构造 hosts 写入脚本（由 runElevated 提权执行）。两个要点：
// ① 备份**每次刷新**（不是「只建一次」）—— 只建一次时，若 hosts 在安装后被第三方追加了
//    条目，那份陈旧备份里没有它们，卸载/回滚时会把它们一起抹掉。
// ② 读写统一用 [Text.Encoding]::Default（系统 ANSI 代码页），保证 hosts 里的非 ASCII
//    注释（不少工具会写中文标记）编码不变。
export function buildApplyScript(hostsPath, tmpPath) {
  const bak = `${hostsPath}.ghprobe-bak`;
  return `
try { [Console]::OutputEncoding = [Text.Encoding]::UTF8 } catch {}
$src = '${hostsPath}'
$tmp = '${tmpPath}'
$bak = '${bak}'
$marker = '${BEGIN}'
$enc = [Text.Encoding]::Default
try {
  Copy-Item -Force $src $bak
  Copy-Item -Force $tmp $src
  $now = [IO.File]::ReadAllText($src, $enc)
  if ($now -notmatch [regex]::Escape($marker)) {
    Copy-Item -Force $bak $src
    [Console]::Error.WriteLine('hosts 校验失败：未找到 ghprobe 标记，已回滚')
    exit 1
  }
  ipconfig /flushdns | Out-Null
  exit 0
} catch {
  if (Test-Path $bak) { Copy-Item -Force $bak $src }
  [Console]::Error.WriteLine('hosts 写入失败: ' + $_.Exception.Message)
  exit 1
}
`;
}

// 构造 hosts 还原脚本（由 runElevated 提权执行）：剥掉整个 ghprobe 块后写回。
// 刻意**不**用 *.ghprobe-bak 直接覆盖 —— 备份是「写入前」的快照，可能含旧块，也可能
// 早于第三方后来追加的条目。直接剥块才能保证「只移除 ghprobe 自己的行」。
// 🔴 必须用状态机跳过 begin..end 之间的**所有行**：早期写法是 `Where-Object { $_ -notmatch
//    '^# === ghprobe (begin|end) ===' }`，它只删标记行、把块内 IP 条目全留下 ——
//    以前靠备份分支兜着没暴露，去掉备份分支后就会留下一堆孤儿条目。
export function buildRestoreScript(hostsPath) {
  return `
try { [Console]::OutputEncoding = [Text.Encoding]::UTF8 } catch {}
$src = '${hostsPath}'
$enc = [Text.Encoding]::Default
try {
  $current = [IO.File]::ReadAllText($src, $enc)
  $keep = @()
  $skip = $false
  foreach ($line in ($current -split '\\r?\\n')) {
    if ($line -match '^# === ghprobe begin ===') { $skip = $true; continue }
    if ($line -match '^# === ghprobe end ===') { $skip = $false; continue }
    if (-not $skip) { $keep += $line }
  }
  $clean = ($keep -join [Environment]::NewLine).TrimEnd() + [Environment]::NewLine
  [IO.File]::WriteAllText($src, $clean, $enc)
  ipconfig /flushdns | Out-Null
  exit 0
} catch {
  [Console]::Error.WriteLine('hosts 还原失败: ' + $_.Exception.Message)
  exit 1
}
`;
}

// 事务化提权写入：刷新备份 -> 覆盖 -> 校验含 BEGIN -> 失败回滚 -> 刷 DNS 缓存
export async function applyHosts(merged, hostsPath = WIN_HOSTS) {
  const tmp = path.join(os.tmpdir(), `ghprobe-hosts-${Date.now()}.tmp`);
  fs.writeFileSync(tmp, merged, "utf8");
  try {
    const r = await runElevated(buildApplyScript(hostsPath, tmp));
    if (r.code !== 0) { throw new Error(`提权写入失败: ${r.err || r.out}`); }
    return { ok: true, backup: `${hostsPath}.ghprobe-bak` };
  } finally {
    try { fs.unlinkSync(tmp); } catch { /* 清理失败不管 */ }
  }
}

// 还原 hosts：剥掉 ghprobe 块后写回；最后刷 DNS 缓存
export async function restoreHosts(hostsPath = WIN_HOSTS) {
  const r = await runElevated(buildRestoreScript(hostsPath));
  if (r.code !== 0) { throw new Error(`还原 hosts 失败: ${r.err || r.out}`); }
  return { ok: true };
}
