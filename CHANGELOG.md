# Changelog

本项目的所有重要变更都记录在此文件。

格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [Unreleased]

### Changed

- **许可证收敛为 `GPL-3.0-only`**（原 `GPL-3.0-or-later`）：刻意不接受「或任何更高版本」，
  避免他人在版本解释上做文章。`LICENSE` 重写为纯英文官方 GPLv3 正文，附录模板填入真实
  程序名/年份/作者/仓库地址（`https://github.com/zmw-zmw/ghprobe`）
- **健康哨兵间隔 5 分钟 → 1 分钟**（`schedule.healthMin`）。这是「IP 死了到自动换掉」的
  最坏等待时间：探测本身只要 ~20s，用户却平均要多等 2.5 分钟 —— 瓶颈在调度间隔而非探测。
  1 分钟是 Task Scheduler 重复间隔的下限
- **部分更新只探被诊断的域名**：典型场景「`github.com` 的 IP 死了，`codeload` / `jsdelivr`
  还活着」原先会把 6 个域名、近 50 个候选全探一遍。现在只探失败的那 1 个（~8 个候选），
  端到端修复时间 ~90s → ~20s
- **DoH 解析改为并行**：原先 6 个域名串行，最坏耗时 = 域名数 × `dohMs`（30s）；并行后压回一个 `dohMs`
- **探测任务改用全局并发池**：原先每域名各开一个池，实际并发 = 域名数 × `concurrency`（36 条
  socket），最坏耗时与瞬时连接数被同时放大
- **计划任务无窗口运行**：Task Scheduler 起 `node.exe` 必弹控制台窗口，而 node 没有隐藏窗口的
  开关。改为注册 `wscript.exe` 跑一个 VBS 包装器（`WScript.Shell.Run(cmd, 0, True)` = `SW_HIDE`）
- README 中英双版重写：补项目介绍、逐条列出的痛点、工作原理、完整使用方式（命令）、
  以及「为什么会出现 `cdn.jsdelivr.net`」的正面说明

### Added

- **`stuck` 上报**：被诊断了、本轮却一个活 IP 都没找到、只能保留旧值的域名，会显式写进日志
  （`stuck=github.com`）。此前只记 `action=none reason=无变化`，在黑洞窗口里会让人误以为工具没干活
- 已提权时跳过提权包装（`isElevated()`）：计划任务本身就以最高权限运行，原先
  `applyHosts` 还会再走一次 `Start-Process -Verb RunAs`，多拉一个控制台窗口，是无窗口运行的第二个破口

### Fixed

- **windows-latest CI 失败**（`not ok 48`）：`buildUninstallTaskScript` 的实跑用例用裸
  `fs.writeFileSync` 落盘 `.ps1`（无 UTF-8 BOM）。英文 Windows 的 ANSI 代码页是 CP1252，
  中文「任务」的 UTF-8 字节里含 `0x92`，在 CP1252 下被解成 `’`（U+2019）—— 而 PowerShell
  把 `’` 当作**合法单引号定界符**，字符串被提前截断 → `ParserError: Missing ')' in method call`。
  中文 Windows（GBK）恰好不暴露此问题，所以本地一直绿的。改用 `writePs1WithBom`
- **部分更新时白跑兜底轮**：`neededFallbacks` 原先只要 `ranked` 里取不到某域名就判「全灭」。
  但 `rank` 对「本轮没探过」的域名根本不建键，于是每轮都会白跑一次兜底 DoH + 探测
- 🔴 **「明明有活 IP，工具却报 stuck」**（线上实测复现）：候选池只有 3 个 Azure IP，
  而 DoH 对 `github.com` 返回的 8 条里常有一半是 Fastly 的 `185.199.x.x`（那是
  `githubusercontent` 的节点，不给 `github.com` 服务）。两个来源合并后又做了**总限额**
  `slice(0, maxCandidates)` → 内置池被这堆垃圾整个挤掉。实测当时 `20.29.134.23`、
  `20.233.83.145`、`20.87.245.0` 等 8 个 IP 都是活的，工具却连报三轮 `stuck=github.com`。
  三处修：① 内置池扩到 24 个（GitHub 官方 `meta` 的 `web` /32 + `140.82.112.0/20`）；
  ② **两个来源各自限额后再合并**，不再对合并结果做总限额；③ 新增 `domainPools` 按域名族
  分配池（`185.199.x.x` 永远不给 `github.com` 服务，互探纯属浪费）
- **死候选把全量探测拖长**：原先 TCP 与 TLS 共用 `tlsMs`(6s)，黑洞 IP 的 TCP 握手会一直
  挂到超时 —— 20 个候选要 12s+，所以池子一直不敢放宽。新增 `timeouts.tcpMs`(2.5s)：
  TCP 阶段用短超时快速淘汰，`connect` 后再切到 `tlsMs`，**20 个候选降到 6.1s**

## [0.1.0] - 2026-10-11

首个公开版本。

### Added

- 本地 DoH 联邦取候选：RFC 8484 wire format，端点 IP 直连（不走 UDP/53），默认国内实测可达端点
- 三关探测：TCP RTT → TLS 握手 + 证书域名校验 → HTTP 应用层终审（状态码 / 错误特征 / 必需特征 / 跳转白名单）
- 兜底链：主域名候选全灭时自动探测替身域名（如 `raw.githubusercontent.com` → `cdn.jsdelivr.net`）
- hosts 块生成与事务化提权写入（刷新备份 / 覆盖 / 校验标记 / 失败回滚 / flushdns）
- 自适应调度层：每 5 分钟健康哨兵（只测已写入 IP）+ 异常才触发全量重排 + 跨进程写锁
- 无状态冷却：缺失域名记入 hosts 块内 `# absent` 注释，跨进程、跨重启不丢
- 一键部署脚本 `install.ps1` / `install.cmd`（自提权、检查 Node、注册计划任务、写 hosts、自检回显）
- 本地 HTTP API（`serve`：`POST /api/probe`、`GET /api/status`、`GET /api/hosts`、`GET /api/config`）
- 单元测试 72 项（`node --test`，含 Windows 专属用例的平台跳过）
- CI：Windows 全量 + ubuntu 跨平台逻辑双矩阵

### Fixed

- **提权假成功**：`Start-Process -Verb RunAs` 失败时抛的是非终止错误，脚本会继续执行，
  `$p` 仍为 `$null`，而 `exit $null` 等价于退出码 0 —— 把「UAC 被取消」伪装成「hosts 已写入」。
  现加 `-ErrorAction Stop` + `if ($null -eq $p) { exit 1 }`（判空早于取退出码）
- **横向判据误触发**：旧判据 `failed * 2 > total` 的分母只数已写入条目（常低到 3~4），
  实测「3 条陈旧 + 1 条健康」被误判为断网 → 该修的时候不修。改为「仅当全部已写入 IP 同时失败」才判网络故障
- **`probe --apply` 缺全灭护栏**：全灭时会写入空块，把原本可用的映射一起抹掉
- **两条写入路径块格式不一致**：`probe --apply` 不写 `# absent` 冷却注释，导致下一轮 health 把缺失域名当「首次缺失」白跑全量
- **`uninstall` 未提权删计划任务**：任务建在根目录且以最高权限注册，非提权删除会「拒绝访问」
- **提权脚本中文乱码**：`runElevated` 生成的临时 `.ps1` 缺 UTF-8 BOM，
  PowerShell 5.1 会按系统 ANSI（GBK）解析，脚本内中文字面量整段乱码
- **备份只建一次**：`*.ghprobe-bak` 原先仅在缺失时创建。hosts 被第三方追加条目后，
  那份陈旧备份里没有这些条目，回滚会把它们一起抹掉
- **还原脚本剥块不彻底**：原 `Where-Object { $_ -notmatch '^# === ghprobe (begin|end) ===' }`
  只删除标记行，块内 IP 条目全部残留（此前被备份分支掩盖）
- `Write-Error` 会把整行源码回显进 stderr，改用 `[Console]::Error.WriteLine` 输出干净单行

### Security

- hosts 读写统一使用系统 ANSI 代码页，避免改动 hosts 中非 ASCII 注释的字节
- 提权脚本以 UTF-8 BOM 落盘，杜绝编码解析歧义
- 写入前校验块标记存在，失败自动回滚；还原时只移除本工具自己的行

[Unreleased]: https://github.com/zmw-zmw/ghprobe/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/zmw-zmw/ghprobe/releases/tag/v0.1.0
