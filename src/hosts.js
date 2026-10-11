// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 zmw
// hosts 片段生成 + 事务化提权写入 + 还原 + DNS 缓存刷新
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";

export const WIN_HOSTS = "C:\\Windows\\System32\\drivers\\etc\\hosts";
const BEGIN = "# === ghprobe begin ===";
const END = "# === ghprobe end ===";

// 用户级数据目录（日志、无窗口包装器）。放 %LOCALAPPDATA% 而不是包目录：
// npm 全局安装时包目录在 node_modules 下，npm 升级/重装会整个换掉。
export function userDataDir() {
  const base = process.env.LOCALAPPDATA || path.join(os.homedir(), ".ghprobe");
  return path.join(base, "ghprobe");
}

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

// 构造「写入 hosts + 注册计划任务」的提权脚本（install 用）：一次 UAC 完成两件事。
// 与 buildApplyScript 的区别：中途不 exit，两件事都做完后再按综合结果返回退出码，
// 这样 install 只需弹一次 UAC，且能拿到「两件事各自成功与否」的确定结果。
export function buildInstallScript({ hostsPath, tmpPath, nodePath, binPath, cfgArg = "", minutes = 1, writeHosts = true, vbsPath = "" }) {
  const bak = `${hostsPath}.ghprobe-bak`;
  const hostsPart = writeHosts ? `
try {
  Copy-Item -Force $src $bak
  Copy-Item -Force $tmp $src
  $now = [IO.File]::ReadAllText($src, $enc)
  if ($now -match [regex]::Escape($marker)) { $hostsOk = $true }
  else { Copy-Item -Force $bak $src; [Console]::Error.WriteLine('hosts 校验失败：未找到 ghprobe 标记，已回滚') }
} catch {
  if (Test-Path $bak) { Copy-Item -Force $bak $src }
  [Console]::Error.WriteLine('hosts 写入失败: ' + $_.Exception.Message)
}
if ($hostsOk) { ipconfig /flushdns | Out-Null }` : "";
  // 任务动作二选一：
  // ① 有 VBS 包装器（默认）→ 用 wscript.exe 跑它，VBS 内以 SW_HIDE 启动 node —— 全程无窗口；
  // ② 没有（老调用方 / 包装器写失败）→ 直接跑 node，功能不受影响，但会闪一个控制台窗口。
  const actionLine = vbsPath
    ? `$a = New-ScheduledTaskAction -Execute "$env:SystemRoot\\System32\\wscript.exe" -Argument ('"' + '${vbsPath}' + '"')`
    : `$a = New-ScheduledTaskAction -Execute '${nodePath}' -Argument '"${binPath}" health --apply${cfgArg}'`;
  return `
try { [Console]::OutputEncoding = [Text.Encoding]::UTF8 } catch {}
$src = '${hostsPath}'
$tmp = '${tmpPath}'
$bak = '${bak}'
$marker = '${BEGIN}'
$enc = [Text.Encoding]::Default
$hostsOk = $${writeHosts ? "false" : "true"}
${hostsPart}
$taskOk = $false
try {
  ${actionLine}
  $t = New-ScheduledTaskTrigger -Once -At (Get-Date) -RepetitionInterval (New-TimeSpan -Minutes ${minutes})
  $p = New-ScheduledTaskPrincipal -UserId "$env:COMPUTERNAME\\$env:USERNAME" -LogonType Interactive -RunLevel Highest
  Register-ScheduledTask -TaskName ghprobe -Action $a -Trigger $t -Principal $p -Force | Out-Null
  $taskOk = $true
} catch {
  [Console]::Error.WriteLine('注册计划任务失败: ' + $_.Exception.Message)
}
if ($hostsOk -and $taskOk) { exit 0 }
exit 1
`;
}

// 构造「无窗口运行」包装器（VBScript）。
// 为什么需要它：Task Scheduler 在交互会话里启动控制台程序（node.exe）会**必然**新建一个
// 控制台窗口，而 node.exe 没有任何「隐藏窗口」开关（不像 powershell 有 -WindowStyle Hidden）。
// 唯一可靠的做法是让 wscript.exe 起一层：WScript.Shell.Run 的第二个参数是 ShowWindow 风格，
// 传 0 = SW_HIDE，且该方式自 Win7 起一直有效。第三个参数 True = 等子进程结束再退出。
// VBS 字符串里 `"` 要写成 `""`（成对双写），所以路径里的引号要整体转义一遍。
export function buildHiddenRunnerVbs(nodePath, binPath, args = "") {
  const cmd = `"${nodePath}" "${binPath}"${args ? " " + args : ""}`;
  return [
    "' ghprobe 无窗口运行包装器（由 ghprobe install 生成，请勿手改；ghprobe uninstall 会删除它）",
    'Set sh = CreateObject("WScript.Shell")',
    `sh.Run "${cmd.replace(/"/g, '""')}", 0, True`,
    "",
  ].join("\r\n");
}

// 判断当前进程是否已经有管理员权限：hosts 是只有管理员能写的系统文件，
// 用「以读写方式打开」做探测，成功即已提权。比 spawn 一个 PowerShell 去查 token 便宜得多，
// 而且不产生任何窗口。已提权时 applyHosts 直接跑脚本，不再走 Start-Process -Verb RunAs
// （那条路会再拉一个新控制台窗口，无窗口运行就破了）。
export function isElevated(hostsPath = WIN_HOSTS) {
  try { fs.closeSync(fs.openSync(hostsPath, "r+")); return true; } catch { return false; }
}

// 跑一段 PowerShell 命令，回传 { code, out, err }
function runPowerShellCommand(cmd) {
  return new Promise((resolve, reject) => {
    const child = execFile("powershell", ["-NoProfile", "-Command", cmd], { windowsVerbatimArguments: true, windowsHide: true });
    let out = "";
    let err = "";
    child.stdout?.on("data", (d) => { out += d; });
    child.stderr?.on("data", (d) => { err += d; });
    child.on("close", (code) => resolve({ code, out, err }));
    child.on("error", reject);
  });
}

// 直接执行一个 .ps1（调用方保证已经提权）。windowsHide 让 powershell 以 CREATE_NO_WINDOW
// 启动，不闪窗；被提升的父进程若本身就在隐藏控制台里，子进程也是继承而非新建。
function runPowerShellFile(file) {
  return new Promise((resolve, reject) => {
    const child = execFile("powershell", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", file], { windowsHide: true });
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

// 写临时 ps1 -> 提权执行 -> 取回退出码 -> 清理 ps1（apply/restore/install 复用）。
// 已经提权时（计划任务 runlevel=highest）直接执行脚本，不走 Start-Process -Verb RunAs ——
// 后者会再拉一个独立控制台窗口，是「无窗口运行」的第二个破口。
export async function runElevated(content) {
  const tmp = path.join(os.tmpdir(), `ghprobe-${Date.now()}.ps1`);
  writePs1WithBom(tmp, content);
  try {
    if (isElevated()) { return await runPowerShellFile(tmp); }
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
