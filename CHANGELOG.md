# Changelog

本项目的所有重要变更都记录在此文件。

格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

> **版本号说明**：npm 发布采用 `0.1.x` 版本线（`npm i -g ghprobe` 装到的就是它）；
> 0.1.5 及之前的 npm 包内含仓库内部 0.2~0.6 的全部能力（对应关系：npm 0.1.5 ≈ 内部 0.6.0）。
> **自 0.1.6 起条目直接使用 npm 版本号**，内部版本号不再单独记录。

## [0.1.8] - 2026-11-14

### Added

- **代理保活待命模式（无缝切换的核心）**：检测到本地代理存活时，hosts 直连条目**全部注释**
  （`# idle` 行 + `# proxy-idle` 标记）—— 流量已交代理，hosts 钉 IP 不仅无用，在 Clash
  fake-ip/TUN 模式下还会绕过代理破坏分流；注释态对代理零干扰，注释前的条目即第一份备用块
  （standby）。daemon 按 `proxy.idleProbeMin`（默认 5 分钟，远低于直连模式的 15~45s）节流
  继续**直连**全量重测候选，standby 始终新鲜；未到点时每轮只做缓存命中的存活检查，近零成本。
- **代理停止 -> 立即转正（<1 秒）再校准**：「存活 -> 死亡」跃迁的瞬间先把 standby 注释条目
  转正（直连解析立即就位，不等重测），随后后台全量重测校准。无缝切换的关键是
  **恢复先于校准** —— 校准只负责修正 standby 期间的陈旧。
- **监督者兜底**：daemon 崩溃时，每分钟的监督任务经 `runHealth` 的 idle 分支也能完成
  「代理死了 -> 恢复保活条目」的兜底（恢复不依赖 daemon 存活）。
- **status / doctor 保活模式展示**：条目注释不再误导为「没装好」，明确显示待命状态与恢复语义。

### Changed

- 全灭纪律延伸到保活：保活探测全灭时**绝不覆盖非空 standby**（否则代理一停就恢复了个寂寞）；
  校准写入与现内容相同时跳过（不无谓重写 hosts / flushdns）。
- 候选池刷新扩展到保活路径：保活重测前到点刷池，恢复之后的重排才有宽候选可用。

### 测试

- 单元测试 245 -> **256**（idle 编码往返 / 状态机进入-节流-恢复 / 全灭护栏 / 监督者兜底 / 展示）。
- 真机全链路（真实 Clash 7890 + 真实直连探测，hosts 写临时文件）：进入保活 47.6s 建齐
  standby；零成本跳过；节流重测刷新；模拟代理死亡后 9 域名立即转正 + 43.8s 校准完成。

## [0.1.7] - 2026-11-14

### Added

- **本地代理共存（`src/proxy.js`）**：检测本机 HTTP CONNECT 代理（环境变量 → Windows 系统代理
  注册表 → 常见本地端口扫描，含 Clash 7890/7897、v2rayN 10809 等），每层命中都以
  `CONNECT github.com:443` 实测「经它可达 GitHub」才算可用；结果短缓存（30s）。
- **代理视角判活（抗抖动核心）**：直连探活失败时借代理做第二视角 —— 代理说活 =
  IP 全局没死 = 本机链路抖动，本轮不换 IP（块里写 `# suspect 域名 时间戳` 记录宽限）；
  宽限期（`algorithm.suspectGraceMs`，默认 10 分钟）内同一域名再失败 = 路由级问题，
  立即切换。代理视角也说死 = 确认真死，照旧立即切。
  TLS 指纹阻断类失败不参与宽限（那是 SNI 封锁，代理视角活得再好直连也过不去）。
- **代理停止 → 立即全量重测**：daemon 盯代理存活，「存活 → 死亡」跃迁的瞬间（用户流量
  正落回直连、hosts 最要好的时刻）全量重探所有域名并重写 hosts，P0 优先级、不走浏览器门控。
- **doctor / status 代理检查项**：doctor 报检测到的代理与可用性；status 显示本地检测结果
  （status 保持零网络请求的承诺 —— 只做本地检测）。

### Changed

- **备选 IP 差异化（`ranker.pickAlts`）**：hosts 的备选条目不再按分数顺位取（常与主 IP
  同 /24、同 POP、一起死），优先挑不同网段 —— 不同 /16 > 同 /16 不同 /24 > 同 /24 兜底。
  真正的「主挂了备选顶上」。
- 全灭护栏在有代理视角数据时让位：代理确认 GitHub 全局可达时不再按「疑似网络故障」跳过，
  该宽限的宽限、确认死的照常重排。

### Fixed

- `detectProxy` 存活检查后未销毁隧道 socket（每次检测泄漏一条长连接）。

### 测试

- 单元测试 220 → **245**（代理解析/隧道/判活/宽限语义/备选差异化/跃迁重测，全注入式；
  隧道用真实本地 net 服务验证 CONNECT 报文）。
- 真机验证：Clash 7890 端口扫描命中；GitHub 主站抖动窗口内旧算法白白重排、
  新算法正确判定「代理视角可达 → 宽限一轮，零打扰」。

## [0.1.6] - 2026-11-13

### Added

- **`ghprobe off` / `ghprobe on`：一键暂停与恢复（不卸载）**。off = 剥掉 hosts 块 +
  暂停计划任务 + 落暂停标记，daemon / 健康检查见到标记直接跳过（连探测请求都不发）；
  on = 反向恢复并当场触发一轮健康检查，约 1 分钟内重新写好 hosts。
  适合出差、换网、临时装了代理工具的场景，不用整个 uninstall。
  手动 `probe --apply` 是显式意图不受门约束，但会提示当前处于暂停状态。
- **`ghprobe report`：报障诊断包**。版本 / 系统 / 暂停状态 / status / 配置差异 /
  hosts 块 / 自愈日志尾部一次收集，自动复制到剪贴板并落盘
  （`%LOCALAPPDATA%\ghprobe
eport-<时间>.txt`），提 issue 直接粘贴。
- **更新检查**：交互命令（install / status / doctor / probe / report）每天最多查一次
  npm registry（npmmirror 优先、官方源兜底、5s 超时、失败静默），有新版提示
  `npm i -g ghprobe`。只提示不自动升级；daemon / 计划任务静默路径绝不联网查版本。

### Fixed

- **自愈日志无限膨胀**（重要）：daemon / 监督者每 15~60s 追加一行，日志此前只增不减，
  长跑机器实测可攒到几十 MB。现在追加前自动滚动：超过 2MB 只保留最后 256KB，
  老用户升级后下次写入自动截断，无需手动清理。

### Changed

- `status` 在暂停状态下首行显示恢复指引；hosts 块被 off 剥掉时不再误导用户「先跑 install」。
- `uninstall` 顺带清掉暂停标记（重装 = 全新开始）。


## [0.6.0] - 2026-10-31

### Added

- **用户行为感知的切换时机算法（`src/algorithm.js`）**：换 IP 不是零成本 —— flushdns +
  连接池重建，正在浏览的页面会卡一下。daemon 现在按「打扰成本 vs 紧急度」决定何时落盘：
  - **成本权重**（可配 `algorithm.weights`）：前台是浏览器 100 > 浏览器在后台跑 30 >
    前台是其他软件 10 > 空闲 0；
  - **P0 不吃权重**：当前主备全死、用户此刻真的断着的域名 → **立即切**。「正在用」
    和「不能用」二选一，当然选别断网；首次写入（无从打扰）同此；
  - **非紧急优化类**（提上备选 / 重排优化 / 补缺失 / 兜底写入）在前台是浏览器时**推迟**，
    攒成待写块由 daemon 每轮检查，用户空闲后落地；推迟上限 `deferMaxMs`（默认 10 分钟）防饿死。
  - 检测免管理员：`tasklist` 扫浏览器进程（名单可配）+ PowerShell `GetForegroundWindow`
    查前台窗口；结果短缓存（beforeApply 同轮复用，空闲落地走新鲜检测）。
  - 只作用于 daemon 自动写入；手动 `health --apply` / `probe --apply` 是显式意图，不设门。
- 顺带修正：`fullUpdate` 写入时把 `hostsPath` 传给 `applyHosts`（此前健康检查的写路径
  测试注入会被忽略，默认恰好等于真实 hosts 才未暴露）。
- 单元测试 192 → **201**（tasklist 解析 / 成本权重 / 决策矩阵 / 门控与空闲落地，全注入）。

## [0.5.0] - 2026-10-31

### Added

- **常驻 daemon（无缝切换的核心）**：`ghprobe daemon` 以 15~45s **自适应循环**持续自愈——
  全部健康 45s、有异常/stuck/出错 15s、断网 120s。取代「每分钟起一个新进程」的固定节拍：
  故障发现不再等下一分钟，修复全程无进程启动开销。实测架构目标：抖动窗口结束后的
  恢复延迟从 ~6 分钟量级压进 ~1 分钟以内。
  - 每轮写心跳文件（`daemon.heartbeat`）；单实例：发现更年轻的活实例自动让位；
  - 每轮重载配置：编辑 `config.yaml` 即时生效；
  - 循环体异常不退出（按 15s 快档重试）。
- **监督者架构（零迁移成本）**：现有的每分钟计划任务**原地降级**为监督者——
  心跳新鲜 → 秒退（本轮交给 daemon）；心跳陈旧/没有 → **自动拉起新 daemon** + 本轮照常兜底。
  daemon 崩溃 → 下一分钟自动复活。旧版本用户升级 npm 包后自动获得，**无需重装、无需新 UAC**。
  手动诊断用 `ghprobe health --force` 绕过监督逻辑。
- **status 显示常驻守护状态**：`常驻守护：运行中（pid …，心跳 Ns 前）` 一眼可见。
- 单元测试 185 → **192**（心跳/单实例/自适应间隔/主循环全注入，不打网络不真睡）。

## [0.4.0] - 2026-10-31

### Changed

- **🔴 修正 `raw.githubusercontent.com` 探测判据路径（潜伏 bug）**：
  `DOMAIN_SIG` 里的 `/torvalds/linux/README.md` 在真 GitHub 上是 **404** ——
  raw 的第 2 段是分支名，无分支的路径会被当作「README.md 分支」。就算网络全通，
  该判据也会把活 IP 判死（假阴性）。修正为 `/torvalds/linux/master/README`
  （实测 200 且含 "Linux kernel"；linux 仓库根文件本来就叫 `README`，无 `.md`）。
- **默认兜底链按实测数据重写**（jsDelivr 官方多 CDN，同一份内容、官方运营、无中间人）：

  | 替身 | 2026-10-31 实测 |
  | --- | --- |
  | `fastly.jsdelivr.net`（新，首选） | Fastly anycast 151.101.x.229，node+双 curl 全栈全 IP **100%**，TTFB ~125ms |
  | `testingcf.jsdelivr.net`（新） | Cloudflare 段，100%，与 Fastly 真正异构 |
  | `gcore.jsdelivr.net`（新） | 100%，但当前与 testingcf 解析到同一对 CF IP，纯语义冗余 |
  | ~~`cdn.jsdelivr.net`~~（移除） | **0/45**：TCP 全通、ClientHello 后即 RST（SNI 硬封），换 IP/换 TLS 栈均无效 |

  三个替身都以**完整写法**入配置（自带 `/gh/torvalds/linux@master/README` + mustContain 判据，
  它们不在代码 DOMAIN_SIG 里，简写会退回探根路径的弱判据）。
  老用户没改过 `fallbacks` 的自动跟随新默认；改过的用 `ghprobe config-diff` 查看。

### Added

- **`ghprobe status` 秒级速查**：不打任何网络请求，汇总「hosts 块现状（每域名主 IP + 备选 +
  缺失/阻断标记）+ 计划任务状态 + 自愈日志尾部」。与 doctor 的分工：日常「现在什么情况」用
  status（<1s），坏了要诊断再用 doctor（~1 分钟）。
- **候选池拉取自救**：`updatePool` 支持**健康 hosts 条目当备用种子**（排在静态 seed 之前）——
  它们刚通过三关 + HTTP 终审，是「当下确实能直连 GitHub」的 IP；seed 池被 SNI 整段封锁时
  这批 IP 往往是唯一还拉得到 `api.github.com/meta` 的入口，池子不再永久冻结。
  `health` 与 `update-pool` 两条路径都已接入。
- 单元测试 178 → **185**。

### Investigated（按用户要求实测，结论如实记录）

- **Cloudflare 1.1.1.1：当前网络全封死，不可用** —— UDP 53 超时、TCP 53 超时、
  DoH 直连 IP 超时、`cloudflare-dns.com` 秒 RST。另勘测确认本机 System32 curl 与 Git
  mingw64 curl 均为 Schannel 构建（与「mingw=OpenSSL」的既有假设不符，栈对比结论不受影响）；
  系统 DNS（UDP 53 出站）全部不可用，DoH 是唯一解析通道 —— 印证了本工具「DoH 端点 IP 直连」的设计。

## [0.3.0] - 2026-10-31

### Added

- **`github.githubassets.com` 加入默认域名族**：github.com 网页的全部 JS/CSS/字体都从这里
  加载 —— 不写它「页面能打开但样式全裂」，是直连浏览最常见的体验杀手。
  🔴 它的 Fastly 段是 `185.199.108-111.215`，与 githubusercontent 系的 `.133` **不同段**
  （实测 `.133` 对该 SNI 直接连接失败），所以单独建 `ghassets` 池。
  判据用 `GET /favicons/favicon.svg`（实测 4 个 .215 IP 全部 200 且以 `<svg` 开头）。
- **`ssh.github.com` 加入默认域名族（SSH-over-443）**：`git clone git@ssh.github.com:...`
  的入口，SNI 封锁下最稳的 SSH 通道。探测类型新增 `type:"ssh"`：服务端先发 banner，
  读到合法 `SSH-2.0-*` 即活，不走 TLS/HTTP 三关（`sshProbe`）。
- **schannel 二次重探**：Node 的 TLS ClientHello 被中间设备识别并 reset 时（README §3 实测：
  同一 IP 同一时刻 openssl 20/20、Node 5/20、浏览器正常），改用 **Windows 自带的 curl.exe
  （Schannel 构建，与 Edge 同一 TLS 栈）** 重探一次。为此 probeIp 的端口改为可注入。
  重探结果的语义随之升级：
  - schannel 通 → 写入 hosts（0.3.0 前这种情况只能写 `# blocked` 放弃，而浏览器明明能用）；
  - schannel 后 HTTP 层仍 4xx → 假活，与指纹无关，不标 blocked；
  - schannel 后连接层仍被 reset → **连浏览器同款栈都过不去**，`# blocked` 从此是
    「浏览器栈验证过确实被拦」的强结论，不再可能是客户端指纹的假阴性。
  🔴 必须显式定位 System32 的 curl.exe：PATH 前面的可能是 Git 自带的 OpenSSL 构建
  （实测 mingw64 curl 走 OpenSSL，指纹又变回去）。
- **排名双采样抗抖动**：对每域名前 3 名再采一枪，`mergeSamples` 按均值 + 失败罚分
  （500ms/次）重排名。单采样时同一 IP 相邻两轮分差可达数倍、排名近乎随机，
  而无谓的换 IP 要刷 DNS 缓存、断连接池 —— 排名稳比单次「最优」更重要。
  `probe.stableSamples: 2`（默认开），设 1 退回旧行为。
- 单元测试 166 → **178**（SSH banner 解析/探测、schannel 注入路径、双采样合并、
  githubassets 判据；全部本地 socket 与注入替身，不打真网络）。

### Live validation (2026-10-31, 真实网络)

- 首轮 probe：`ssh.github.com` 经 banner 判活（20.205.243.160，54ms）；
  `github.githubassets.com` 4 个 .215 全活（最优 score 36）；`api.github.com` /
  `github.com`（双采样后 4 个可用）正常。
- `raw/gist/avatars.githubusercontent.com`（.133 段）本轮全灭 —— schannel 重探同样被
  connection reset，证实是网络层对该批 SNI 的真实封锁，**不是工具的指纹假阴性**；
  工具如实标 blocked/absent 并走冷却，这正是设计行为。

## [0.2.0] - 2026-10-30

### Added

- **`ghprobe doctor` 一键自检**：把「本地网络 / DoH 解析 / 逐域名探测 / hosts 写入状态 /
  计划任务」五层各查一遍，逐项给人话结论 + 下一步建议（如「跑 `ghprobe update-pool`」
  「重跑 `ghprobe install`」）。定位：GitHub 连不上时，普通人不该被要求去读日志——
  一条命令看懂哪层坏了、该做什么。有 fail 项时退出码非零，方便脚本消费；
  `# blocked` 类域名只标 warn 不算失败（浏览器可能仍可用，不该吓退用户）。
  评估逻辑拆成纯函数、编排依赖可注入，单测不打真网络。
- **`api.github.com` 加入默认域名族**：gh CLI（`gh api`）与 REST API 直连提速。
  DNS 同样被污染，此前 hosts 不管它。判据用 `GET /rate_limit`（未认证也返回 200，
  响应体必含 `rate` 字段，不依赖网页特征）；候选走 seed/auto 池（GitHub 自租段）。
  老用户升级后经三方合并自动获得该域名（没动过 `domains` 键的话）。
- **DoH 端点增加 DNSPod 第二入口 `120.53.53.53`**（与 `1.12.12.12` 同证书 `doh.pub`）：
  单端点抖动时解析不再整体失明。真实网络实测 4/4 端点可用。
- 单元测试 153 → **166**。

### Notes

- `ghprobe serve` 的 HTTP API 保持不变（`POST /api/probe`、`GET /api/status`、
  `GET /api/hosts`、`GET /api/config`），供脚本消费。

## [0.1.3] - 2026-10-12

### Changed

- **默认配置不再预置任何第三方代理域名**（`ghproxy.net` / `gh-proxy.com` 已从 `fallbacks` 移除）：
  本工具定位「无代理」，默认预置第三方代理既与该定位矛盾，也有法律风险。
  默认兜底只保留公共 CDN `cdn.jsdelivr.net`；多候选与自带判据机制保留，用户可自行添加替身。
- README（中英）第 6 节、§3 边界、免责声明同步收紧：明确「不预置任何第三方代理 / 镜像域名」。

### Upgrade

- 三方合并会把新默认带给**没动过** `fallbacks` 的用户；动过的保留原值。
  老用户配置里若残留 `ghproxy.net` / `gh-proxy.com`，`ghprobe config-diff` 可见，自行删除即可。

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
