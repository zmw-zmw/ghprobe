// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 zmw
// 离线单测：hosts 块生成与合并替换 + 跨进程写锁
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { buildBlock, mergeHosts, acquireHostsLock, releaseHostsLock, HOSTS_LOCK, buildElevateCommand, runElevationWrapper, buildUninstallTaskScript, writePs1WithBom } from "../src/hosts.js";

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
  fs.writeFileSync(tmp, buildUninstallTaskScript("ghprobe-definitely-not-exist-xyz"), "utf8");
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
