#Requires -Version 5.1
<#
  ghprobe 一键部署（Windows / PowerShell 5.1+）

  用法：
    .\install.ps1                 部署：注册计划任务 + 立即写入一次 hosts
    .\install.ps1 -SkipProbe      只注册计划任务，等首轮健康检查自己写 hosts
    .\install.ps1 -Uninstall      卸载：删除计划任务 + 还原 hosts

  也可以直接双击 install.cmd（等价）。
  全程只弹一次 UAC：脚本先自提权，之后的注册/写 hosts 都在管理员会话内静默完成。
#>
[CmdletBinding()]
param(
  [switch]$Uninstall,
  [switch]$SkipProbe,
  [string]$LogFile,
  [switch]$Inner
)

$ErrorActionPreference = 'Stop'
$Root = $PSScriptRoot
if ([string]::IsNullOrWhiteSpace($LogFile)) { $LogFile = Join-Path $env:TEMP 'ghprobe-deploy.log' }

function Say([string]$m) {
  $line = "[ghprobe] $m"
  Write-Host $line
  try { Add-Content -LiteralPath $LogFile -Value $line -Encoding UTF8 } catch { }
}

# ── 1. 自提权（注册计划任务需要管理员）────────────────────────────────
# 只弹一次 UAC：子进程在管理员会话里跑完，父进程回显子进程写的日志。
$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if ((-not $isAdmin) -and (-not $Inner)) {
  Say "需要管理员权限，正在申请提权（只会弹一次 UAC）…"
  Remove-Item -LiteralPath $LogFile -ErrorAction SilentlyContinue
  $psArgs = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', "`"$PSCommandPath`"", '-Inner', '-LogFile', "`"$LogFile`"")
  if ($Uninstall) { $psArgs += '-Uninstall' }
  if ($SkipProbe) { $psArgs += '-SkipProbe' }
  $proc = Start-Process -FilePath 'powershell.exe' -Verb RunAs -Wait -PassThru -ArgumentList $psArgs
  # 注意：Start-Process 被取消时 $proc 为 $null。若直接 exit $proc.ExitCode，
  # PowerShell 会退化成 exit $null = 0，把"用户拒绝提权"伪装成成功。
  if ($null -eq $proc) { Write-Host "[ghprobe] 提权被取消，未做任何改动。"; exit 1 }
  if (Test-Path -LiteralPath $LogFile) { Get-Content -LiteralPath $LogFile | ForEach-Object { Write-Host $_ } }
  exit $proc.ExitCode
}

Set-Location -LiteralPath $Root
Say "工作目录：$Root"

# ── 2. 环境检查：Node >= 18 ─────────────────────────────────────────
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  Say "错误：未找到 Node.js（需要 >= 18）。请先安装：https://nodejs.org/"
  exit 1
}
# 用 Out-String 兜底：node 异常时输出可能为 $null，直接 .Trim() 会抛「不能对 Null 值表达式调用方法」
$nodeVer = (& node -p "process.versions.node" 2>$null | Out-String).Trim()
if ([string]::IsNullOrWhiteSpace($nodeVer)) { Say "错误：无法执行 node -p，Node 安装可能损坏"; exit 1 }
$okVer = $false
try { $okVer = ([version]$nodeVer -ge [version]'18.0.0') } catch { Say "错误：无法识别 Node 版本：$nodeVer"; exit 1 }
if (-not $okVer) { Say "错误：Node 版本 $nodeVer 过低（需要 >= 18）"; exit 1 }
Say "Node $nodeVer OK"

# ── 3. 依赖 ─────────────────────────────────────────────────────────
if (-not (Test-Path -LiteralPath (Join-Path $Root 'node_modules'))) {
  Say "安装依赖（npm install --omit=dev）…"
  & npm install --omit=dev --no-audit --no-fund
  if ($LASTEXITCODE -ne 0) { Say "错误：npm install 失败"; exit 1 }
} else {
  Say "依赖已就绪"
}

$Cli = Join-Path $Root 'bin\ghprobe.js'
$Hosts = 'C:\Windows\System32\drivers\etc\hosts'

# ── 4a. 卸载分支 ────────────────────────────────────────────────────
if ($Uninstall) {
  Say "删除计划任务并还原 hosts…"
  & node $Cli uninstall
  if ($LASTEXITCODE -ne 0) { Say "错误：卸载失败"; exit 1 }
  if (Get-ScheduledTask -TaskName 'ghprobe' -ErrorAction SilentlyContinue) {
    Say "自检失败：计划任务 ghprobe 仍然存在"; exit 1
  }
  Say "完成：计划任务已删除，hosts 已还原。"
  exit 0
}

# ── 4b. 注册计划任务（当前已是管理员，内部不会再弹 UAC）──────────────
Say "注册计划任务（每 5 分钟健康检查，异常才全量换 IP）…"
& node $Cli install
if ($LASTEXITCODE -ne 0) { Say "错误：注册计划任务失败"; exit 1 }

# ── 5. 立即写入一次 hosts，装完即用 ──────────────────────────────────
if (-not $SkipProbe) {
  Say "立即跑一次全量探测并写入 hosts（约 1 分钟）…"
  & node $Cli probe --apply
}

# ── 6. 自检：不信任命令行自报的成功 ──────────────────────────────────
$task = Get-ScheduledTask -TaskName 'ghprobe' -ErrorAction SilentlyContinue
if (-not $task) { Say "自检失败：未找到计划任务 ghprobe"; exit 1 }
Say ("自检：计划任务存在（State={0}，重复间隔={1}，RunLevel={2}）" -f $task.State, $task.Triggers[0].Repetition.Interval, $task.Principal.RunLevel)

$inBlock = $false
$block = @()
foreach ($line in (Get-Content -LiteralPath $Hosts)) {
  if ($line -match '^# === ghprobe begin ===') { $inBlock = $true; continue }
  if ($line -match '^# === ghprobe end ===') { $inBlock = $false; continue }
  if ($inBlock) { $block += $line.Trim() }
}
if ($block.Count -gt 0) {
  Say "自检：hosts 中的 ghprobe 块："
  $block | ForEach-Object { Say "        $_" }
} else {
  Say "自检：hosts 暂无 ghprobe 块（计划任务首轮会自动写入）"
}

Say "全部完成。此后无需敲命令：每 5 分钟自动健康检查，IP 陈旧时自动重排。"
Say "卸载：.\install.ps1 -Uninstall"
