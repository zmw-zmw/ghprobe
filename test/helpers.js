// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 zmw
// 测试公共前置：把用户数据目录指到临时目录。
// 🔴 必须做：config.loadConfig() / pool.* 会读写 %LOCALAPPDATA%\ghprobe，
//    不隔离的话测试会读到本机真实配置（install 之后必然存在）-> 结果不可重复。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

if (!process.env.GHPROBE_TEST_DATA_DIR) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ghprobe-test-"));
  process.env.GHPROBE_TEST_DATA_DIR = dir;
  process.env.LOCALAPPDATA = dir;   // userDataDir() 读的就是它
}
