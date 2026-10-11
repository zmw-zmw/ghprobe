// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 zmw
// 离线单测：hosts 块生成与合并替换 + 跨进程写锁
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { buildBlock, mergeHosts, acquireHostsLock, releaseHostsLock, HOSTS_LOCK, buildElevateCommand, runElevationWrapper, buildUninstallTaskScript, writePs1WithBom, buildApplyScript, buildRestoreScript, buildInstallScript, buildHiddenRunnerVbs, userDataDir } from "../src/hosts.js";

const ranked = new Map([["github.com", [{ ip: "20.205.243.166" }, { ip: "20.27.177.113" }]]]);
const extra = new Map([["cdn.jsdelivr.net", [{ ip: "104.16.0.1" }]]]);

test("buildBlock: 含 begin/end 标记与条目", () => {
  const block = buildBlock(ranked, extra);
  assert.ok(block.startsWith("# === ghprobe begin ==="));
  assert.ok(block.endsWith("# === ghprobe end ==="));
  assert.ok(block.includes("20.205.243.166 github.com"));
  assert.ok(block.includes("104.16.0.1 cdn.jsdelivr.net"));
});

test("mergeHosts: 替换旧块且保留其他行", () => {
  const current = ["# 本机原有条目", "127.0.0.1 localhost", "# === ghprobe begin ===", "9.9.9.9 old.com", "# === ghprobe end ===", "# 尾注"].join("\n");
  const merged = mergeHosts(current, buildBlock(ranked, extra));
  assert.ok(merged.includes("127.0.0.1 localhost"));
  assert.ok(merged.includes("# 尾注"));
  assert.ok(!merged.includes("9.9.9.9 old.com"));
  assert.equal((merged.match(/ghprobe begin/g) || []).length, 1);
  assert.ok(merged.endsWith("\n"));
});

test("mergeHosts: 无旧块时追加", () => {
  const merged = mergeHosts("127.0.0.1 localhost", buildBlock(ranked, new Map()));
  assert.ok(merged.includes("20.205.243.166 github.com"));
  assert.ok(merged.includes("127.0.0.1 localhost"));
});

test("acquireHostsLock: 独占 + 冲突超时放弃 + 释放后可再拿", () => {
  try { fs.unlinkSync(HOSTS_LOCK); } catch { /* 无残留即无锁 */ }
  const fd = acquireHostsLock(800, 50);
  assert.ok(fd != null, "首次应拿到锁");
  const fd2 = acquireHostsLock(300, 50);
  assert.equal(fd2, null, "已被持有，短暂自旋后放弃本轮");
  releaseHostsLock(fd);
  const fd3 = acquireHostsLock(800, 50);
  assert.ok(fd3 != null, "释放后应能再次拿到");
  releaseHostsLock(fd3);
});

// ── 提权假成功回归（B1）──────────────────────────────────────────────
// 旧写法 `$p = Start-Process … -Verb RunAs …; exit $p.ExitCode` 在用户取消 UAC 时，
// Start-Process 抛的是非终止错误 → 脚本继续 → $p 仍为 $null → `exit $null` = 退出码 0
// → applyHosts 以为写成功，对外报「hosts 已写入」。下面两条锁住这个回归。
test("buildElevateCommand: 判空必须早于 exit $p.ExitCode", () => {
  const cmd = buildElevateCommand("powershell", ["-NoProfile", "-File", "C:\\tmp\\x.ps1"]);
  const iNull = cmd.indexOf("$null -eq $p");
  const iExit = cmd.lastIndexOf("exit $p.ExitCode");
  assert.notEqual(iNull, -1, "缺少 $p 判空保护：提权失败会被伪装成成功");
  assert.notEqual(iExit, -1, "缺少 exit $p.ExitCode：拿不到被提升进程的退出码");
  assert.ok(iNull < iExit, "判空必须发生在使用 $p.ExitCode 之前");
  assert.ok(cmd.includes("-ErrorAction Stop"), "Start-Process 必须带 -ErrorAction Stop，否则失败不是终止错误");
});

test("runElevationWrapper: Start-Process 自身失败必须返回非零退出码", { skip: process.platform !== "win32" }, async () => {
  // 用一个必然不存在的目标让 Start-Process 立刻失败（不会弹 UAC）
  const r = await runElevationWrapper("C:\\nope\\nope-does-not-exist.exe", []);
  assert.notEqual(r.code, 0, `提权失败被伪装成成功（code=${r.code}），applyHosts 会误报「hosts 已写入」`);
});

// ── uninstall 自提权删任务（B3）──────────────────────────────────────
// 旧 uninstall 用非提权 spawnSync 删任务：任务建在根目录且 RunLevel=Highest，
// 非提权删会「拒绝访问」，而当时只打一行 stderr 就当失败处理（甚至可能静默）。
// 现在改为 runElevated 提权执行 buildUninstallTaskScript()。
test("buildUninstallTaskScript: 先判空后删除 + 删除失败必须非零退出", () => {
  const s = buildUninstallTaskScript("ghprobe");
  assert.ok(s.includes("Get-ScheduledTask -TaskName 'ghprobe'"), "缺少任务存在性检查（幂等性）");
  assert.ok(s.includes("-ErrorAction SilentlyContinue"), "判空查询不应抛错，否则首次安装前跑 uninstall 会失败");
  assert.ok(
    s.includes("Unregister-ScheduledTask -TaskName 'ghprobe' -Confirm:$false -ErrorAction Stop"),
    "删除必须带 -ErrorAction Stop：否则「拒绝访问」是非终止错误，脚本会继续走到 exit 0 把失败伪装成成功",
  );
  const iCheck = s.indexOf("Get-ScheduledTask");
  const iDel = s.indexOf("Unregister-ScheduledTask");
  assert.ok(iCheck < iDel, "必须先判空再删除，保证重复执行幂等");
  assert.ok(/exit 0/.test(s), "缺少成功/跳过时的退出码 0");
});

test("buildUninstallTaskScript: 任务不存在时幂等退出 0", { skip: process.platform !== "win32" }, async () => {
  const tmp = path.join(os.tmpdir(), `gp-uninstall-test-${Date.now()}.ps1`);
  // 🔴 必须用 writePs1WithBom（带 UTF-8 BOM），不能裸 fs.writeFileSync：
  // 英文 Windows 的 ANSI 代码页是 CP1252，中文「任务」的 UTF-8 字节里含 0x92，
  // 在 CP1252 下解成 ’（U+2019）—— 而 PowerShell 把 ’ 当合法单引号定界符，
  // 字符串被提前截断 → ParserError。中文 Windows（GBK）恰好不会暴露这个问题。
  writePs1WithBom(tmp, buildUninstallTaskScript("ghprobe-definitely-not-exist-xyz"));
  try {
    const r = await new Promise((resolve) => {
      execFile("powershell", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", tmp], (e, out, err) => {
        resolve({ code: e ? (typeof e.code === "number" ? e.code : 1) : 0, out, err });
      });
    });
    assert.equal(r.code, 0, `任务不存在时应幂等退出 0，实际 code=${r.code} err=${r.err}`);
  } finally {
    try { fs.unlinkSync(tmp); } catch { /* 清理失败不管 */ }
  }
});

test("Get-ScheduledTask 对不存在任务：SilentlyContinue 不抛、Stop 才抛", { skip: process.platform !== "win32" }, async () => {
  const run = (cmd) => new Promise((resolve) => {
    execFile("powershell", ["-NoProfile", "-Command", cmd], (e, out, err) => {
      resolve({ code: e ? (typeof e.code === "number" ? e.code : 1) : 0, out: String(out), err: String(err) });
    });
  });
  const soft = await run("if (-not (Get-ScheduledTask -TaskName 'ghprobe-xyz-nope' -ErrorAction SilentlyContinue)) { exit 0 } else { exit 9 }");
  assert.equal(soft.code, 0, "SilentlyContinue 下任务不存在应判为假且不抛错");
  const hard = await run("try { Get-ScheduledTask -TaskName 'ghprobe-xyz-nope' -ErrorAction Stop | Out-Null; exit 9 } catch { exit 3 }");
  assert.equal(hard.code, 3, "Stop 下应抛终止错误（印证删除动作必须带 -ErrorAction Stop 才不会被吞）");
});

// 退出码穿透：uninstall 判成功与否只看外层 code，所以「内层 exit N → 外层 N」必须成立。
// 这里用等价的 Start-Process -Wait -PassThru（不提权，故不弹 UAC）验证机制本身。
test("Start-Process -Wait -PassThru 的退出码穿透（非零必须带回）", { skip: process.platform !== "win32" }, async () => {
  const cmd = "try { [Console]::OutputEncoding = [Text.Encoding]::UTF8 } catch {};"
    + " $p = Start-Process -FilePath 'cmd.exe' -ArgumentList '/c','exit 7' -Wait -PassThru -NoNewWindow -ErrorAction Stop;"
    + " if ($null -eq $p) { exit 1 }; exit $p.ExitCode";
  const r = await new Promise((resolve) => {
    execFile("powershell", ["-NoProfile", "-Command", cmd], (e, out, err) => {
      resolve({ code: e ? (typeof e.code === "number" ? e.code : 1) : 0, out: String(out), err: String(err) });
    });
  });
  assert.equal(r.code, 7, `退出码未穿透（code=${r.code}）：uninstall 删任务失败会被误判为成功`);
});

// ── 提权脚本文件编码（D1）────────────────────────────────────────────
// runElevated 把脚本写成临时 .ps1 再以 -File 执行。PowerShell 5.1 对「无 BOM 的 .ps1」
// 按系统 ANSI（中文系统 = GBK）解析 → 脚本里的中文字面量整段乱码。实测症状：
// Node 侧收到的 stderr 是「璁″垝浠诲姟 …」而不是「计划任务 …」。必须写 UTF-8 BOM。
test("writePs1WithBom: 文件必须以 UTF-8 BOM 开头且内容为可读 UTF-8", () => {
  const tmp = path.join(os.tmpdir(), `gp-bom-${Date.now()}.ps1`);
  try {
    writePs1WithBom(tmp, "[Console]::Error.WriteLine('计划任务不存在')\n");
    const buf = fs.readFileSync(tmp);
    assert.deepEqual([...buf.subarray(0, 3)], [0xef, 0xbb, 0xbf], "缺少 UTF-8 BOM：PS 5.1 会按 GBK 解析，中文提示变乱码");
    assert.ok(buf.toString("utf8").includes("计划任务不存在"), "BOM 之后的内容应为可读 UTF-8");
  } finally {
    try { fs.unlinkSync(tmp); } catch { /* 清理失败不管 */ }
  }
});

test("带 BOM 的提权脚本：Node 侧收到的中文 stderr 不乱码", { skip: process.platform !== "win32" }, async () => {
  const tmp = path.join(os.tmpdir(), `gp-bom-run-${Date.now()}.ps1`);
  writePs1WithBom(tmp, buildUninstallTaskScript("ghprobe-definitely-not-exist-xyz"));
  try {
    const r = await new Promise((resolve) => {
      execFile("powershell", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", tmp], (e, out, err) => {
        resolve({ code: e ? (typeof e.code === "number" ? e.code : 1) : 0, err: String(err) });
      });
    });
    assert.equal(r.code, 0);
    assert.ok(r.err.includes("不存在"), `中文 stderr 乱码（收到 ${JSON.stringify(r.err)}），检查 .ps1 是否带 BOM`);
    assert.ok(!/[\u4e00-\u9fff]/.test(r.err) || r.err.includes("计划任务"), "stderr 应包含完整可读中文提示");
  } finally {
    try { fs.unlinkSync(tmp); } catch { /* 清理失败不管 */ }
  }
});

// ── 备份刷新与还原语义（C3）──────────────────────────────────────────
// 旧实现两个毛病：① 备份「只建一次」，hosts 被第三方追加条目后那份备份是陈旧的，
// 卸载/回滚会连带抹掉别人的条目；② restoreHosts 直接拿备份覆盖，同样丢条目。
const PS = "powershell";
const runPs1 = (file) => new Promise((resolve) => {
  execFile(PS, ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", file], (e, out, err) => {
    resolve({ code: e ? (typeof e.code === "number" ? e.code : 1) : 0, err: String(err) });
  });
});

test("buildApplyScript: 备份必须每次刷新（不能只在缺失时创建）", () => {
  const s = buildApplyScript("C:\\Windows\\System32\\drivers\\etc\\hosts", "C:\\tmp\\x.tmp");
  assert.ok(s.includes("Copy-Item -Force $src $bak"), "缺少备份步骤");
  assert.ok(!s.includes("if (-not (Test-Path $bak))"), "备份只在缺失时创建：hosts 被第三方追加条目后，卸载会连带抹掉");
  assert.ok(s.includes("[Text.Encoding]::Default"), "读写应用系统 ANSI 编码，避免改动 hosts 中非 ASCII 注释的字节");
});

test("buildRestoreScript: 不得用备份直接覆盖（否则回滚掉第三方新增条目）", () => {
  const s = buildRestoreScript("C:\\Windows\\System32\\drivers\\etc\\hosts");
  assert.ok(!s.includes("$bak"), "还原脚本不应引用 *.ghprobe-bak：那是写入前快照，可能含旧块");
  assert.ok(s.includes("ghprobe begin") && s.includes("ghprobe end"), "缺少剥块标记匹配");
  assert.ok(s.includes("$skip"), "缺少跳过块内行的状态机：只删标记行会留下孤儿条目");
  assert.ok(s.includes("[Text.Encoding]::Default"), "读写应用系统 ANSI 编码");
});

test("buildApplyScript 实跑：刷新备份 + 写入 + 保留写入前内容", { skip: process.platform !== "win32" }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gp-apply-"));
  const fake = path.join(dir, "hosts");
  const tmpf = path.join(dir, "new.tmp");
  const bak = `${fake}.ghprobe-bak`;
  fs.writeFileSync(fake, "# orig\n1.1.1.1 a.example.com\n");
  fs.writeFileSync(bak, "# STALE BACKUP from long ago\n");
  fs.writeFileSync(tmpf, "# orig\n1.1.1.1 a.example.com\n# === ghprobe begin ===\n9.9.9.9 github.com\n# === ghprobe end ===\n");
  const ps1 = path.join(dir, "apply.ps1");
  writePs1WithBom(ps1, buildApplyScript(fake, tmpf));
  try {
    const r = await runPs1(ps1);
    assert.equal(r.code, 0, `写入脚本失败: ${r.err}`);
    assert.ok(fs.readFileSync(fake, "latin1").includes("9.9.9.9 github.com"), "新块未写入");
    const bakText = fs.readFileSync(bak, "latin1");
    assert.ok(!bakText.includes("STALE BACKUP"), "备份未刷新，仍是陈旧内容");
    assert.ok(bakText.includes("1.1.1.1 a.example.com"), "备份应保留写入前的内容");
  } finally {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* 忽略 */ }
  }
});

test("buildRestoreScript 实跑：剥块 + 保留第三方条目 + 非 ASCII 字节不变", { skip: process.platform !== "win32" }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gp-restore-"));
  const fake = path.join(dir, "hosts");
  const GBK_TEST = Buffer.from([0xb2, 0xe2, 0xca, 0xd4]); // "测试" 的 GBK 字节
  fs.writeFileSync(fake, Buffer.concat([
    Buffer.from("# Microsoft sample\n", "ascii"),
    Buffer.from("# third-party note ", "ascii"), GBK_TEST, Buffer.from("\n", "ascii"),
    Buffer.from("1.1.1.1 third.example.com\n", "ascii"),
    Buffer.from("# === ghprobe begin ===\n", "ascii"),
    Buffer.from("20.205.243.166 github.com\n", "ascii"),
    Buffer.from("# === ghprobe end ===\n", "ascii"),
    Buffer.from("2.2.2.2 tail.example.com\n", "ascii"),
  ]));
  const ps1 = path.join(dir, "restore.ps1");
  writePs1WithBom(ps1, buildRestoreScript(fake));
  try {
    const r = await runPs1(ps1);
    assert.equal(r.code, 0, `还原脚本失败: ${r.err}`);
    const buf = fs.readFileSync(fake);
    const text = buf.toString("latin1");
    assert.ok(!text.includes("ghprobe begin") && !text.includes("ghprobe end"), "ghprobe 块未被移除");
    assert.ok(!text.includes("20.205.243.166 github.com"), "块内条目未被移除");
    assert.ok(text.includes("1.1.1.1 third.example.com"), "第三方条目被误删");
    assert.ok(text.includes("2.2.2.2 tail.example.com"), "尾部第三方条目被误删");
    assert.ok(buf.includes(GBK_TEST), "非 ASCII 注释字节被改动（编码未保真）");
  } finally {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* 忽略 */ }
  }
});

// ── install：一次提权完成「写 hosts + 注册任务」（E1）──────────────────
test("buildInstallScript: 写 hosts 段不得提前 exit，否则任务注册被跳过", () => {
  const s = buildInstallScript({
    hostsPath: "C:\\Windows\\System32\\drivers\\etc\\hosts", tmpPath: "C:\\tmp\\x.tmp",
    nodePath: "C:\\node\\node.exe", binPath: "C:\\pkg\\bin\\ghprobe.js", cfgArg: "", minutes: 5, writeHosts: true,
  });
  assert.ok(s.includes("Copy-Item -Force $tmp $src"), "缺少写 hosts 步骤");
  assert.ok(s.includes("Register-ScheduledTask -TaskName ghprobe"), "缺少注册计划任务");
  assert.ok(s.includes("New-ScheduledTaskPrincipal") && s.includes("-RunLevel Highest"), "任务必须以最高权限注册（否则写 hosts 会再弹 UAC）");
  assert.ok(s.includes("New-ScheduledTaskTrigger") && s.includes("New-TimeSpan -Minutes 5"), "缺少按 schedule.healthMin 的重复触发器");
  assert.ok(s.includes("-LogonType Interactive"), "LogonType 应为 Interactive");
  // 关键：写 hosts 的失败分支不得提前退出，否则后面的注册根本执行不到
  const iWrite = s.indexOf("Copy-Item -Force $tmp $src");
  const iReg = s.indexOf("Register-ScheduledTask");
  const iFirstExit = s.indexOf("exit ", iWrite);
  assert.ok(iReg > iWrite, "注册应在写 hosts 之后");
  assert.ok(iFirstExit === -1 || iReg < iFirstExit, "写 hosts 段提前 exit 会让任务注册被跳过");
  assert.ok(s.includes("[Text.Encoding]::Default"), "读写应用系统 ANSI 编码");
});

test("buildInstallScript: writeHosts=false 时不碰 hosts，但仍注册任务", () => {
  const s = buildInstallScript({
    hostsPath: "C:\\h", tmpPath: "C:\\t", nodePath: "n", binPath: "b", cfgArg: "", minutes: 5, writeHosts: false,
  });
  assert.ok(!s.includes("Copy-Item -Force $tmp $src"), "--skip-probe 时不应写 hosts");
  assert.ok(s.includes("$hostsOk = $true"), "跳过写 hosts 时应把该步视为通过");
  assert.ok(s.includes("Register-ScheduledTask"), "仍应注册任务");
});

// ── 无窗口运行：node.exe 没有隐藏窗口开关，只能靠 wscript + VBS 的 SW_HIDE ──
test("buildHiddenRunnerVbs: ShowWindow 传 0(SW_HIDE) 且等待子进程结束", () => {
  const vbs = buildHiddenRunnerVbs("C:\\node\\node.exe", "C:\\pkg\\bin\\ghprobe.js", "health --apply");
  const line = vbs.split(/\r?\n/).find((l) => l.startsWith("sh.Run"));
  assert.ok(line, "缺少 sh.Run 行");
  assert.ok(line.endsWith(', 0, True'), `第三个参数必须是 0(隐藏)+True(等待)，实际: ${line}`);
  assert.ok(vbs.includes('CreateObject("WScript.Shell")'));
});

test("buildHiddenRunnerVbs: 带空格路径的引号在 VBS 字符串里成对转义", () => {
  const vbs = buildHiddenRunnerVbs("C:\\Program Files\\nodejs\\node.exe", "C:\\a b\\ghprobe.js", "health --apply");
  const line = vbs.split(/\r?\n/).find((l) => l.startsWith("sh.Run"));
  // VBS 里 " 要写成 ""，所以 `"path"` 会变成 `""path""`
  assert.ok(line.includes('""C:\\Program Files\\nodejs\\node.exe""'), "node 路径引号未转义");
  assert.ok(line.includes('""C:\\a b\\ghprobe.js""'), "bin 路径引号未转义");
  // 剥掉最外层那对「字符串定界符」后，剩余内容里不得再有落单的 "（落单 = VBS 语法崩）
  const body = line.slice("sh.Run ".length, line.length - ", 0, True".length);
  assert.ok(body.startsWith('"') && body.endsWith('"'), `参数未用引号包裹: ${body}`);
  assert.equal(body.slice(1, -1).replace(/""/g, "").includes('"'), false, "存在未成对转义的引号");
});

test("buildInstallScript: 给了 vbsPath 就走 wscript，没给则退回直接跑 node", () => {
  const withVbs = buildInstallScript({
    hostsPath: "C:\\h", tmpPath: "C:\\t", nodePath: "C:\\node\\node.exe", binPath: "C:\\b.js", vbsPath: "C:\\d\\run-hidden.vbs",
  });
  assert.ok(withVbs.includes("wscript.exe"), "有包装器时应由 wscript 启动");
  assert.ok(withVbs.includes("C:\\d\\run-hidden.vbs"), "任务动作应指向 VBS 包装器");
  assert.equal(withVbs.includes("-Execute 'C:\\node\\node.exe'"), false, "有包装器时不该再直接跑 node");

  const noVbs = buildInstallScript({
    hostsPath: "C:\\h", tmpPath: "C:\\t", nodePath: "C:\\node\\node.exe", binPath: "C:\\b.js",
  });
  assert.ok(noVbs.includes("-Execute 'C:\\node\\node.exe'"), "无包装器时应退回直接跑 node");
  assert.equal(noVbs.includes("wscript.exe"), false);
});

test("userDataDir: 落在用户数据目录下的 ghprobe 子目录（npm 升级不会清掉）", () => {
  assert.equal(path.basename(userDataDir()), "ghprobe");
  assert.ok(userDataDir().includes("ghprobe"));
});
