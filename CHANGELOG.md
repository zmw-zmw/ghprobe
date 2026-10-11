# Changelog

本项目的所有重要变更都记录在此文件。

格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [Unreleased]

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

[Unreleased]: https://github.com/OWNER/ghprobe/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/OWNER/ghprobe/releases/tag/v0.1.0

<!-- 仓库公开后，把上面两行链接里的 OWNER/ghprobe 替换为真实地址。 -->
