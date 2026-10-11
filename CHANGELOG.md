# Changelog

本项目的所有重要变更都记录在此文件。

格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [0.1.2] - 2026-10-11

### Added

- **配置升级机制（三方合并）**：解决「默认值的改进到不了老用户」——
  用户配置是 `install` 时**整份复制**的、且优先于包内默认，所以默认文件里**已有键**的新值
  永远不生效（数组是整体替换，不合并）。现在 `install` 会额外存一份**默认配置快照**
  （`%LOCALAPPDATA%\ghprobe\config.default.snapshot.yaml`），`loadConfig` 做**三方合并**：
  用户值 == 快照值 → 这个键他没动过 → 用**新默认**；否则保留用户值。
  快照**只在缺失时创建、不随升级刷新**（一刷新基准就漂了，没改过的键会被误判成改过）。
  新增 `ghprobe config-diff` 查看用户配置与当前默认的差异；`config-path` 一并打印快照路径。
  ⚠️ 0.1.2 之前装的用户没有快照，跑一次 `ghprobe install` 之后才会建立；在那之前用
  `config-diff` 看差异、手动采纳。
- **兜底链支持多个候选，并挑当下能通的那个**：原来 `fallbacks` 每个主域名只能配一个替身，
  而替身自己也会被封（实测同一时刻 `cdn.jsdelivr.net` 的 TCP 连得上、TLS 被掐）。
  现在默认给三个：`cdn.jsdelivr.net`（jsDelivr 公共 CDN）、`ghproxy.net` / `gh-proxy.com`
  （第三方 GitHub 代理，配置里已注明「请求会经过它们的服务器」，介意可删）。
- **替身可以自带探测判据**：`fallbacks` 新增完整写法
  `- { domain, path, mustContain }`，判据写在配置里而不是代码里 ——
  因为不同替身的 URL 形态不同（CDN 映射 `/gh/<user>/<repo>@<ref>/<path>` vs 代理 `/<完整原始 URL>`），
  用户新增替身不需要改源码。归一化在 `loadConfig()` 里做，下游（`targetDomains` /
  `neededFallbacks`）拿到的仍是 `{ 主域名: [替身域名...] }`，无需改动。

### Changed

- `config.default.yaml` 头部补了升级说明：`install` 会把默认配置**整份**复制成用户配置，
  而用户配置优先 —— 所以**默认值里已有的键，升级后新默认不会自动生效**（新增的键不受影响）。
- README 第 6 节重写（原「关于为什么还会出现 cdn.jsdelivr.net」）：说明兜底链要解决的是
  **换 IP 修不了**的那层封锁、为什么需要多个候选、第三方代理的隐私代价、以及怎么自己加替身。
  并修正了原文「`raw` 被封锁后这类文件没有替代入口」的自相矛盾说法。

### Fixed

- README **中文版**修正两条过时 FAQ：还在说「每个域名只写一条 IP」「Windows 对同一域名只认第一条」——
  这两个说法在 0.1.0 就被实测推翻了（hosts 里同名多条会被解析器**全部返回**、curl / 浏览器
  **逐个尝试**，所以备选是真兜底）。**英文版当时改了、中文版漏了**，两边现在一致。
- 单测 137 → **153**。

## [0.1.1] - 2026-10-11

线上实测驱动的三个修复。都是「工具看着在干活、实际把用户搞断网」那一类。

### Fixed

- 🔴 **假活 IP 被写进 hosts，而客户端不会 fallback**：`github.com` 的状态码白名单里有
  `400/401/403/404`，而 `20.205.243.161` 对该域名的**所有路径**都返回 400、响应体还是 GitHub
  自己的错误页（`<title>Bad request &middot; GitHub</title>`）—— 于是 `mustContain:["github"]`
  也命中，三道判据全部放行，它被排到第 1 名写进 hosts。
  更糟的是「同名多条目 fallback」兜不住它：**400 是合法 HTTP 响应、不是连接失败，客户端不会回退到备选**。
  → 根路径只接受 2xx/3xx；`reject` 加 `"bad request"`。
  （`objects` / `gist` 的 4xx 刻意保留 —— 它们的根路径本来就是 404 / 301，实测响应体里没有 "github"，
  无法用 `mustContain` 兜底，已在代码里注明这是已知的判据弱点。）
- 🔴 **主 IP 挂了、备选是好的，工具却不知道**：`runHealth` 只探**主条目**，备选条目从不探活。
  于是这种最常见的情况被当成「域名挂了」直接重排 —— 撞上 IP 抖动窗口，换了个更差的，用户反而断网。
  → 主 + 备选一起探活；**主挂备活时把备选提上来（promote），不重排**；
  一个域名只有「所有已写入条目全挂」才算挂。
- 🔴 **指纹阻断被误判成「域名不可达」**（假阴性）：ghprobe 自己是 Node，而实测
  （同一 IP、同一 SNI、同一时刻，各 20 次）`openssl s_client` **20/20** 握手成功、node **5/20**、
  curl **3/20**，浏览器能正常打开同一个 URL —— 说明封锁依据是 **TLS ClientHello 的形态**
  （扩展列表 / 顺序 / 长度），既不是主机名、也不是 IP。
  旧逻辑把「TCP 连上了但 TLS 被 reset」当成「这个 IP 不可用」，于是把 `raw.githubusercontent.com`
  写成 `# absent` 并冷却 1 小时 —— **而浏览器明明能用**，工具却主动放弃它。
  → 区分「TCP 阶段失败（IP 真不可用）」与「TLS 阶段失败（本机指纹被识别）」。
- **备选在抖动窗口里被删掉**：`applyDelta` 用「覆盖」而非「合并」处理备选，
  本轮只探到 1 个活 IP 时会把原有备选删掉 —— 恰恰在最需要 fallback 的时候失去它。

### Added

- hosts 块新增 `# blocked <domain> <timestamp>` 注释，与 `# absent` 语义分开：
  `# absent` = 探过、确实没有可用 IP；`# blocked` = **探测不可判**（本机探测客户端的 TLS 指纹被识别），
  用户的浏览器可能仍能访问。两者共用同一档冷却，避免每分钟为不可判的域名白跑一次全量探测。
- 健康检查日志区分三种动作：`提上备选` / `重排换 IP` / `指纹阻断`。
- README（中 / 英）新增「和同类项目的区别」与「边界：哪些问题它解决不了」两节，含四层故障表、
  三客户端实测数据、以及 `# blocked` 与 `# absent` 的语义区别；
  并修正原文「很多工具只处理第一层…束手无策」的不准确说法
  （走代理的工具并不束手无策，应收窄为「**只写 hosts 的**工具」）。
- 单元测试 120 → **137**。

## [0.1.0] - 2026-10-11

首个公开版本。

### Added

- 本地 DoH 联邦取候选：RFC 8484 wire format，端点 IP 直连（不走 UDP/53），默认国内实测可达端点
- 三关探测：TCP RTT → TLS 握手 + 证书域名校验 → HTTP 应用层终审（状态码 / 错误特征 / 必需特征 / 跳转白名单）
- 兜底链：主域名候选全灭时自动探测替身域名（如 `raw.githubusercontent.com` → `cdn.jsdelivr.net`）
- hosts 块生成与事务化提权写入（刷新备份 / 覆盖 / 校验标记 / 失败回滚 / flushdns）
- 自适应调度层：健康哨兵（只测已写入 IP）+ 异常才触发全量重排 + 跨进程写锁
- 无状态冷却：缺失域名记入 hosts 块内 `# absent` 注释，跨进程、跨重启不丢
- 一键部署脚本 `install.ps1` / `install.cmd`（自提权、检查 Node、注册计划任务、写 hosts、自检回显）
- 本地 HTTP API（`serve`：`POST /api/probe`、`GET /api/status`、`GET /api/hosts`、`GET /api/config`）
- CI：Windows 全量 + ubuntu 跨平台逻辑双矩阵
- 单元测试 120 项（`node --test`，含 Windows 专属用例的平台跳过）
- **候选池每天自动跟随官方网段**（`poolUpdate`）：从 GitHub 官方 `api.github.com/meta` 拉最新
  网段，展开成候选 IP 缓存到 `%LOCALAPPDATA%\ghprobe\pool.cache.json`，供 `auto` 池使用。
  实测内置的 24 个 Azure IP 里已有 4 个不在官方 web 段，静态池注定过期。
  两个关键约束：① 拉 meta 必须**种子 IP 直连 + SNI**（`api.github.com` 的 DNS 在国内被污染，
  而这一步恰恰发生在「还没有可用 IP」时）；② 该 API 未认证限 **60 次/小时**，所以
  **成功与失败共用同一档冷却**（`intervalHours`，默认 24h）—— 被 SNI 封锁时反复重试毫无意义，
  还会白撞限流。新增 `ghprobe update-pool` 手动触发（不受周期限制）
- **本地网络检查**（`networkCheck`）：每轮先查 ① 有没有启用的非回环网卡、② TCP 连一下国内
  基准目标（默认 `223.5.5.5:443`）。本机断网时**不探测、不更新池、不写 hosts**，只记一条
  `action=skip reason=本地无网络连接`。理由：断网时所有候选必然全灭，跑一轮纯属浪费，日志还会被
  「stuck / 全灭」刷屏，把「本机没网」和「GitHub 被墙」混在一起反而看不出真故障。基准目标
  刻意不是 GitHub —— 它只判断「本机能不能出去」。`install` 在断网时同样跳过探测，但**照常注册
  计划任务**，有网后自动生效
- **用户可编辑的外部配置文件**：`install` 时把包内默认配置复制到
  `%LOCALAPPDATA%\ghprobe\config.yaml`（已存在则不覆盖），用户可直接编辑候选池 / 超时 /
  调度间隔 / 本地网络检查等。放用户目录而非包目录：npm 升级/重装会整个换掉 `node_modules`。
  优先级 `-c 指定` > 用户目录 > 包内默认。新增 `ghprobe config-path` 打印两个路径
- **同名多条目 + 客户端自动 fallback**（`hosts.maxEntriesPerDomain`，默认 2）：每个域名写
  「最优 IP + 1 条备选」。实测推翻旧假设「Windows 同一域名只取第一条」—— hosts 里同名多条会被
  解析器**全部返回**（保持文件顺序），curl / 浏览器会**逐个尝试**：黑洞 IP 排在前也能 fallback
  到后面的活 IP（`curl` 实测 200）。于是首条 IP 抖动失效时客户端自动走备选，把「断最长 1 分钟」
  压成「多等一个连接超时」。设 1 可退回单条
- **`stuck` 上报**：被诊断了、本轮却一个活 IP 都没找到、只能保留旧值的域名，会显式写进日志
  （`stuck=github.com`）。此前只记 `action=none reason=无变化`，在黑洞窗口里会让人误以为工具没干活
- 已提权时跳过提权包装（`isElevated()`）：计划任务本身就以最高权限运行，原先
  `applyHosts` 还会再走一次 `Start-Process -Verb RunAs`，多拉一个控制台窗口，是无窗口运行的第二个破口

### Changed

- **许可证收敛为 `GPL-3.0-only`**（原 `GPL-3.0-or-later`）：刻意不接受「或任何更高版本」，
  避免他人在版本解释上做文章。`LICENSE` 重写为纯英文官方 GPLv3 正文，附录模板填入真实
  程序名/年份/作者/仓库地址（`https://github.com/zmw-zmw/ghprobe`）
- **`LICENSE` 与官方 GPLv3 原文完全同构**（`gnu.org/licenses/gpl-3.0.txt` 逐行一致，仅末尾
  How to Apply 模板按规范填写）：原先前置了 23 行自定义声明 + 装饰性 `===` 横幅，导致 GitHub 的
  licensee 检测判为 **`Other` / `NOASSERTION`** —— 表现为没有许可证徽标、API 的 `license`
  字段为空、自动化合规工具认不出。**正文之前不能有任何自有文字**（先收敛到 3 行仍失败，
  整体移除后才识别为 `GPL-3.0`）；版权与 GPL-3.0-only 版本锁定声明改为放在
  `package.json` 的 `license` 字段、各源文件 SPDX 头、README「License」段，以及 LICENSE
  末尾的 How to Apply 模板里
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
- **拉 meta 的种子改为「首个成功即返回」**：原先串行试种子，黑洞窗口里要一个个等超时
  （实测 2m13s）；改 `Promise.allSettled` 并行后降到 8.2s —— 但它要等**最慢**那个（正好一个
  `timeoutMs`），等于没真正并行。最终改为并行 + 第一个成功立刻返回并**掐掉其余在飞请求**，
  实测 **0.84s**，且进程立即退出（落败请求已销毁，不会挂着 event loop）
- README 中英双版重写：补项目介绍、逐条列出的痛点、工作原理、完整使用方式（命令）、
  以及「为什么会出现 `cdn.jsdelivr.net`」的正面说明

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

### Security

- hosts 读写统一使用系统 ANSI 代码页，避免改动 hosts 中非 ASCII 注释的字节
- 提权脚本以 UTF-8 BOM 落盘，杜绝编码解析歧义
- 写入前校验块标记存在，失败自动回滚；还原时只移除本工具自己的行

[0.1.2]: https://github.com/zmw-zmw/ghprobe/releases/tag/v0.1.2
[0.1.1]: https://github.com/zmw-zmw/ghprobe/releases/tag/v0.1.1
[0.1.0]: https://github.com/zmw-zmw/ghprobe/releases/tag/v0.1.0
