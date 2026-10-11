# ghprobe

[![ci](https://github.com/zmw-zmw/ghprobe/actions/workflows/ci.yml/badge.svg)](https://github.com/zmw-zmw/ghprobe/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/ghprobe.svg)](https://www.npmjs.com/package/ghprobe)
[![License: GPL-3.0-only](https://img.shields.io/badge/license-GPL--3.0--only-blue.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/node-%3E%3D18-brightgreen.svg)](package.json)
[![Platform](https://img.shields.io/badge/platform-Windows-0078d6.svg)](README.md#系统要求与常见问题)

[English](README.en.md) | 简体中文

**为 GitHub 直连加速的 Windows 命令行工具：在你自己的网络里测出「当前真正能用的 IP」，写进 hosts，并在 IP 失效时自动换掉。不装代理、不改系统代理、不劫持流量。**

它解决的问题很具体：GitHub 直连时快时慢、`git clone` / `git push` 卡死，网上抄来的 hosts 是一份没人维护的静态快照，IP 死了也没人知道。ghprobe 把「找可用 IP」这件事放到本地、自动化、并带自愈。

- 仅支持 **Windows**（写系统 hosts、UAC 提权、注册计划任务都是 Windows 专有能力）
- 只改 **hosts 文件**，不安装任何代理 / 驱动 / 服务
- 运行需要 **Node.js ≥ 18**
- 许可证 **GPL-3.0-only**，作者 **zmw**，仓库 <https://github.com/zmw-zmw/ghprobe>

## 快速开始

```bash
npm install -g ghprobe
ghprobe install     # 探测一次 + 写入 hosts + 注册每分钟健康检查（全程只弹一次 UAC）
ghprobe uninstall   # 停止：删除计划任务并还原 hosts
```

装完即用，之后不用再敲命令。完整命令与配置说明见第 5 节「如何使用」。

---

## 1. 项目介绍

### 它到底做了什么

一句话：**ghprobe 用本地探测挑出 GitHub 相关域名当前最快、最可用的 IP，写成一份会自我维护的 hosts 块。**

一轮完整流程是：先确认本机有网（断网直接跳过）→ 本地 DoH 解析 + 内置候选池（每天自动从官方 meta 更新一次）拿到候选 IP → 对每个候选跑「三关探测」→ 按延迟排名 → 每域名取最优一条 + 1 条备选写进 hosts。之后由计划任务定时做健康检查，IP 死了就自动重排换新 IP。

它**不**提供代理、隧道、流量转发或协议对抗，也**不**试图「突破」什么；只在链路本身可达的前提下做三件事：**优选 IP、剔除假活节点、IP 失效时自动替换**。

### 核心技术点

**① 本地 DoH 解析，绕开系统 DNS 污染**

候选 IP 不来自系统 DNS（可能被污染），而是走 DoH（RFC 8484 wire format，全程无 UDP/53 路径）。默认使用国内实测可达的端点：阿里 DNS（`223.5.5.5` / `223.6.6.6`）和 DNSPod（`1.12.12.12`）。

关键细节：**DoH 端点用 IP 直连 + SNI 校验**。如果连 DoH 端点本身都要先解析它的域名，就会掉进「解析 DoH 域名又要先解析」的死锁；所以配置里端点写的是 IP，同时用 `sni` 字段填服务域名做证书校验（RFC 6066 不允许拿 IP 当 SNI），例如：

```yaml
doh:
  - { name: alidns1, host: 223.5.5.5, sni: dns.alidns.com, path: /dns-query }
  - { name: alidns2, host: 223.6.6.6, sni: dns.alidns.com, path: /dns-query }
  - { name: dnspod,  host: 1.12.12.12, sni: doh.pub,        path: /dns-query }
```

多个端点并发查询，成功者取并集去重，再用内置 IP 池补一批候选。

**② 三关探测：只有三关全过才算「活」**

对每个 `(域名, 候选 IP)` 依次跑：

1. **TCP RTT** —— 在 443 端口建连，量基础网络延迟。
2. **TLS 握手 + 证书 SAN 校验** —— `rejectUnauthorized: true`，且 `servername` 传的是目标域名（SNI）。证书里必须包含目标域名，DNS 污染伪造不出合法证书。
3. **HTTP 应用层终审** —— 带 `Host: <域名>` 发一个真实业务路径的 `GET`，读回少量响应体做校验：状态码是否在允许列表、响应体是否含错误特征、是否含该域名必须出现的特征、3xx 跳转目标是否在白名单内。

**为什么必须有第 3 关？** 因为第 2 关的证书校验挡不住「共享 CDN 上的假活 IP」。举例：Fastly 的 `185.199.x.x` 这类共享节点，会对 `github.com` 返回一张**完全合法**的证书（证书 SAN 确实匹配），但 HTTP 响应体是 `Fastly error: unknown domain` —— 这个 IP 根本没有为 `github.com` 提供服务。只做证书校验就会把这种「假活 IP」当成好节点写进 hosts，结果是 hosts 看着写成功了、GitHub 反而更连不上。第 3 关按**真实业务路径**和**响应内容**做终审，才能把它拦下来（同理，`codeload.github.com` 的根路径可能 301 跳回主站，所以探测用的是归档下载路径，不是根路径）。

**④ 候选池每天自动跟随官方网段，且拉不到就不硬拉**

候选池不只是写死在配置里的静态列表。ghprobe 每天（`poolUpdate.intervalHours`）会从 GitHub 官方 `api.github.com/meta` 拉一次最新网段，展开成候选 IP 缓存到本地，供 `auto` 池使用。这样即使 GitHub 的 Azure 段（`20.x` / `4.x`）发生变动，池子也能自己跟上 —— 实测内置的 24 个 Azure IP 里已经有 4 个不在官方 web 段了。

两个细节：

- **拉 meta 必须 IP 直连 + SNI**：`api.github.com` 的 DNS 在国内被污染，直接请求拿不到响应；而这一步恰恰发生在「还没有可用 IP」的时候，所以只能用配置里的**种子池**（`ipPools.seed`，GitHub 自租段 `140.82.112.0/20`，多年未变）作为直连入口。多个种子**并行**试，第一个成功就返回并掐掉其余请求。
- **拉不到就不重试**：该 API 未认证限 **60 次/小时**，所以成功与失败**共用同一档冷却**（默认 24 小时）。如果 `api.github.com` 被 SNI 层封锁（换 IP 也救不回），反复重试毫无意义，还会白撞限流 —— 直接用现有池 + DoH 继续工作即可。

**⑤ 无代理**

只写 hosts 文件。不装代理软件、不改系统代理设置、不装驱动、不劫持系统流量。卸载时把 hosts 里属于 ghprobe 的那一块剥掉即可，不留残渣。

**⑥ 故障分层认知（这是本项目的价值主张）**

GitHub 连不上，原因不在同一层，能修的手段也不同：

| 故障层            | 现象                              | 能否靠「换 IP」修好                 |
| -------------- | ------------------------------- | --------------------------- |
| **DNS 污染**     | 解析到错误 / 不可达 IP                  | ✅ 能。换一个正确 IP 即可             |
| **SNI 主机名黑名单** | 主机名本身被封锁，TLS 握手里的 SNI 就带着被封锁的域名 | ❌ 不能。换任何 IP 都没用，只能**换域名**兜底 |
| **IP 黑洞**      | 某些 IP 段被整段丢弃                    | ✅ 能。换到可用段即可                 |

很多工具/教程只处理第一层，遇到第二层（如 `raw.githubusercontent.com` 被精确 RST）就束手无策。ghprobe 对第二层有专门的**兜底链**机制（见第 6 节），把「换 IP 修不了」的情况单独处理。

---

## 2. 解决的痛点

**痛点一：GitHub 打不开、图片加载不出来、`git clone` 慢**

`git clone` 卡在 `Receiving objects`、`git push` 超时、网页转圈、README 里的图片全是裂图 —— 同一个仓库、同一个网络，早上能拉、晚上拉不动。因为 GitHub 各域名的可用 IP 随地区、ISP、时段漂移，系统 DNS 给的地址经常是慢的甚至不通的。

**痛点二：抄来的 hosts 是一份静态快照**

网上找的「GitHub hosts 加速」列表，是某个人在某个时间点测出来的一份快照。IP 死了没人知道，更不会自动换。你改一次、管几天，之后又不行了，只能再去找新的 —— 本质上是在手动维护一份注定过期的表。

**痛点三：很多工具要装代理 / 改系统代理 / 装驱动**

为了加速 GitHub，被要求装一堆东西：代理客户端、系统代理开关、TUN/TAP 驱动、后台服务……重、脏，还可能影响浏览器、IDE、其它软件的联网行为。你只是想让 `git clone` 快一点，不想让整个系统的网络路径被改写。

**痛点四：手动 `ping` / `curl` 挑 IP 靠感觉，挑出来的可能是「假活」**

手动 `ping` 只能证明 IP 通不通，证明不了这个 IP 是否真的为 GitHub 服务。共享 CDN 节点会回你一个合法的 TLS 证书，但 HTTP 层面告诉你 `unknown domain` —— 你 ping 着「通」，写进 hosts 却发现 GitHub 更连不上。凭感觉挑 IP，很容易踩这种坑。

**痛点五：开机后 GitHub 突然连不上，只能自己去翻 IP**

IP 失效往往发生在你毫无察觉的时候。没有自动检查，就只能等「哪天用不了」才发现，然后再手动去翻。ghprobe 用计划任务定时自愈：平时静默待命，发现已写入的 IP 失效就自动重排换新，不需要你盯着。

---

## 3. 和同类项目的区别

GitHub 加速这个需求已经有成熟项目在做，大致分三类。ghprobe 站在哪一边，以及各自的代价：

|                        | 静态 hosts 快照<br>（如 GitHub520、ineo6/hosts） | 本地代理<br>（如 dev-sidecar） | **ghprobe**                       |
| ---------------------- | ---------------------------------------- | ------------------------ | --------------------------------- |
| 工作方式                   | 维护者测好后，把一份 hosts 分发给所有人                  | 装本地代理，把请求转发到加速通道         | 在**你自己的网络**里实测，只写 hosts            |
| 要不要装东西                 | 不用                                       | 要装代理 / 证书，且**常驻进程**      | 不用（只有一个每分钟跑一次、秒级退出的计划任务）          |
| 改系统代理？                 | 否                                        | **是**                    | 否                                 |
| IP 从哪来                 | 别人测的，对你不一定最优                             | 不涉及                      | 用 DoH + 三关探测在**你本机**测              |
| IP 失效后                 | 等维护者更新（可能等很久）                            | 不涉及                      | **自动换**（每分钟哨兵）                    |
| 能识别「假活 IP」吗            | 不能                                       | 不涉及                      | 能（第三关按真实业务路径做 HTTP 终审）            |
| 平台                     | 全平台                                      | Windows / macOS / Linux  | Windows                           |

三类各自的代价都是真实的，不是纸上谈兵：

- **静态快照会过期。** IP 是维护者某一时刻测出来的，对**你的**运营商不一定最优；一旦维护者停更就彻底失效 —— `ineo6/hosts` 的内容停在 2023-03-08，`GitHub520` 的 README 里写着服务器 2026-12-31 到期、需要 831 元/年赞助。
- **本地代理有系统级代价。** 装代理、装证书、常驻进程，改的是整个系统的网络路径 —— 而你只是想让 `git clone` 快一点。`dev-sidecar` 的 README 里就记着一个例子：早期版本开着它直接重启电脑会导致无法上网。
- **hosts 管理器只解决「怎么改」**，IP 还得你自己找。

ghprobe 的取舍是：**只做「优选 IP + 自动维护」，不碰系统网络路径**。代价是只支持 Windows（写 hosts、UAC 提权、计划任务都是 Windows 专有能力），且改 hosts 需要一次 UAC 授权 —— `install` 时弹一次，之后由最高权限的计划任务静默运行。

### 边界：哪些问题它解决不了

「GitHub 连不上」不是**一个**问题，是**四个不同层**的问题。ghprobe 只在前三层有效：

| 故障层 | 现象 | 换 IP 能修？ | ghprobe |
| --- | --- | --- | --- |
| **DNS 污染** | 解析到错误 / 不可达 IP | ✅ | ✅ DoH 绕开系统 DNS |
| **IP 黑洞 / 抖动** | 连接超时（`ERR_CONNECTION_TIMED_OUT`） | ✅ | ✅ 探测优选 + 每分钟自愈 |
| **假活 IP** | TCP/TLS 通、但 HTTP 返回 4xx | ✅ | ✅ 第三关按真实业务路径终审 |
| **ClientHello 指纹封锁** | 连接被重置（`ERR_CONNECTION_RESET`） | ❌ | ❌ 见下 |

最后一层要单独讲，因为它最容易被误解 —— 实测数据（同一 IP `185.199.110.133`、同一 SNI `raw.githubusercontent.com`、同一时刻，各 20 次）：

| 客户端 | 握手成功率 |
| --- | --- |
| `openssl s_client` | **20/20** |
| Node.js `tls.connect` | 5/20 |
| `curl` | 3/20 |

**同一个 IP、同一个主机名，只换客户端，结果从 100% 掉到 15%。** 说明拦截依据是 **TLS ClientHello 的形态**（扩展列表、顺序、长度），既不是主机名本身，也不是 IP。这带来两个后果：

1. **换 IP 修不了它** —— 只能换域名。所以本工具有**兜底链**，而且配了**多个替身候选**
   （替身自己也会被封）：见第 6 节。
2. **本工具的探测结果不能完全代表你的体验** —— 它自己是 Node，TLS 指纹和你用的浏览器不同。实测：`raw.githubusercontent.com` 在浏览器里能正常打开，而 Node 探测全部 `ECONNRESET`。遇到这种情况工具会写 `# blocked`（而不是 `# absent`），明确表示**探测不可判**，不是「该域名不可达」：

   ```text
   # blocked raw.githubusercontent.com 2026-10-11T10:27:09.367Z
   ```

   两种标记的区别：`# absent` = 探过、确实没有可用 IP；`# blocked` = 本机探测客户端被识别，你的浏览器很可能照样能用。

**要解决第四层**需要包级手法（TTL 操纵、伪包、TCP 层 desync），那必须装内核驱动（类似 GoodbyeDPI 那类工具）。这跟本项目「不装驱动、不改系统网络路径」的取舍直接冲突，所以**刻意不做**。本工具的定位是：**在你现有的网络条件下，把 IP 选对、并持续维护**。

---

## 4. 工作原理

### 整体流程

```
                        ┌─────────────────────────────────────┐
                        │  配置: domains + DoH 端点 + IP 池    │
                        └──────────────────┬──────────────────┘
                                           │
                          ┌────────────────▼────────────────┐
                          │  本地网络检查 ──无网──▶ 跳过本轮  │  ← 断网时全灭无意义
                          └────────────────┬────────────────┘
                                           │有网
                          ┌────────────────▼────────────────┐
                          │  （每天一次）从官方 meta 更新池    │  ← 失败不重试，等下一周期
                          └────────────────┬────────────────┘
                                           │
                          ┌────────────────▼────────────────┐
                          │  本地 DoH 联邦解析（并发，IP 直连）│  ← 绕开系统 DNS 污染
                          │  + 内置 IP 池 → 候选 IP 列表       │
                          └────────────────┬────────────────┘
                                           │
                          ┌────────────────▼────────────────┐
                          │            三关探测              │
                          │  ① TCP RTT                       │
                          │  ② TLS 握手 + 证书 SAN 校验       │  ← 拦 DNS 污染
                          │  ③ HTTP 应用层终审                │  ← 拦共享 CDN 假活 IP
                          └────────────────┬────────────────┘
                                           │
                            三关全过? ──否──▶ 标记失败，丢弃
                                           │是
                          ┌────────────────▼────────────────┐
                          │  按 score 升序排名，每域名取最优  │
                          └────────────────┬────────────────┘
                                           │
                          ┌────────────────▼────────────────┐
                          │  主域名有活 IP? ──否──▶ 探测兜底域名 │  ← 换域名救 SNI 层封锁
                          └────────────────┬────────────────┘
                                           │
                          ┌────────────────▼────────────────┐
                          │  生成 hosts 块（主 IP + 备选）     │
                          └────────────────┬────────────────┘
                                           │
                          ┌────────────────▼────────────────┐
                          │  UAC 提权写入 hosts + 刷 DNS 缓存  │
                          │  写入前跑「全灭护栏」              │
                          └─────────────────────────────────┘
```

### 三条命令路径的关系

ghprobe 的核心逻辑只有一套（DoH → 三关探测 → 排名），但通过三条不同的命令路径使用：

- **`ghprobe probe`** —— 跑一轮完整探测，**不写 hosts**（加 `--apply` 才写）。适合先看看当前网络能测出什么。
- **`ghprobe health`** —— 健康检查：**只测 hosts 里已经写入的那批 IP**。全健康就静默退出、不动 hosts；只有发现异常才触发全量重排、换 IP。这是计划任务实际调用的命令。
- **`ghprobe install`** —— 一键开启：先做一次健康检查式的保守探测，再在**一次 UAC** 里同时完成「写 hosts」和「注册计划任务（定时调用 `health --apply`）」。

三者写 hosts 时共用同一套规则（同一份块格式、同一道全灭护栏），因此手动 `probe --apply` 和计划任务 `health --apply` 不会互相踩。

### 调度模型：哨兵 + 异常才全量重排

固定频率「每隔 N 小时全量重跑」是错配：网络好时白测，坏时反应太慢。ghprobe 用**分层**替代：

- **哨兵层（默认每 1 分钟）**：一次 `health` 只并发探测 hosts 块里**已写入的那几条 IP**（`probe.concurrency` 条并发），一轮通常 <2 秒。全健康就静默退出，不碰 hosts。
- **重炮层（异常才触发）**：只有确认已有 IP 失效，才跑全量探测（DoH 重解析 + 全部候选三关）。

哨兵间隔由 `schedule.healthMin` 决定，默认 **1 分钟**（也是 Windows Task Scheduler 重复间隔的下限）。它是「IP 死了 → 自动换掉」的**最坏等待时间**。

### 抗抖动与安全设计

- **横向判据（全灭才算断网）**：只有当**已写入的 IP 全部失败**且条目数 ≥ 2 时，才判定为网络级故障（黑洞窗口），本轮什么都不动。只要还有**任意一条健康**，就说明链路是通的，失败的那些是 IP 陈旧 / 真死，触发重排换 IP。（早期的「多数失败即放弃」判据被证实会误触发：分母只数已写入条目、常低到 3~4，会把「3 条陈旧 + 1 条健康」误判成断网，该修的时候不修。）
- **全灭护栏**：写入前若新块**一条有效 IP 都没有**、而 hosts 里还有旧条目，则**拒绝写入、保留旧条目**。避免网络抖动的那几十秒里把原本可用的映射一起抹掉。`probe --apply` 与 `health --apply` 共用这道护栏。
- **部分更新 + IP 粘性**：全量重排后，只更新与当前 hosts **确实不同**的域名；健康域名的 score 微小抖动不会触发换 IP（每次换 IP 都要刷 DNS 缓存、让连接池失效，代价不低）。
- **同名多条目兜底**：每个域名默认写「最优 + 1 条备选」。Windows 会把 hosts 里同名多条**全部返回**、客户端会**逐个尝试**，所以首条 IP 恰好抖动失效时，浏览器 / `git` 会自动走备选 —— 把「断最长 1 分钟」压成「多等一个连接超时」。条数由 `hosts.maxEntriesPerDomain` 控制（默认 2，设 1 退回单条）。
- **`# absent` 冷却**：配置里有、hosts 里没有的域名（典型是被 SNI 层封锁、全量也救不回的域名）会记入 hosts 块内的 `# absent <域名> <时间戳>` 注释，冷却 `schedule.absentCooldownHours`（默认 1 小时）内不再重试，避免重炮每分钟空响。
- **本地断网直接跳过**：每轮先做一次本地网络检查（① 有没有启用的非回环网卡；② TCP 连一下国内基准目标，默认 `223.5.5.5:443`）。本机没网时**不探测、不更新池、不写 hosts**，只在日志里记一条 `action=skip reason=本地无网络连接`。理由：断网时所有候选必然全灭，跑一轮纯属浪费，而且日志会被「stuck / 全灭」刷屏，把「本机没网」和「GitHub 被墙」两种情况混在一起，反而看不出真故障。基准目标刻意**不是 GitHub** —— 它只判断「本机能不能出去」，与 GitHub 是否可达无关。
- **候选池每天自动更新**：从 GitHub 官方 `api.github.com/meta` 拉最新网段，展开成候选 IP 缓存到用户目录，供 `auto` 池使用。为什么需要：GitHub 的 Azure 段在变，内置 `azure` 池会过期（实测 24 个里有 4 个已失效）。该 API 未认证**限 60 次/小时**，所以间隔只能大（默认 24 小时）。若它被 SNI 层封锁（换 IP 也救不回），**失败后同样等满一个周期再试**，不会反复重试 —— 那种情况下继续重试没有意义，用现有池 + DoH 继续工作即可。手动触发 `ghprobe update-pool` 不受周期限制。
- **无状态**：`# absent` 冷却表直接编码在 hosts 块注释里，跨进程、跨重启都不丢，不需要额外的状态文件。
- **跨进程写锁**：`probe --apply` 与计划任务可能并发写 hosts，用锁文件串行化，避免读-改-写互相覆盖；抢不到锁就本轮跳过，下一轮健康检查会自动补写。

### hosts 块长这样

```text
# === ghprobe begin ===
# generated 2026-10-11T00:00:00.000Z by ghprobe
140.82.112.3 github.com
20.27.177.113 github.com
20.27.177.113 codeload.github.com
185.199.108.133 raw.githubusercontent.com
185.199.111.133 raw.githubusercontent.com
# absent gist.githubusercontent.com 2026-10-11T00:00:00.000Z
# === ghprobe end ===
```

`# === ghprobe begin/end ===` 之间归 ghprobe 管，重复写入只替换块内内容；**块外的行（包括你自己的 hosts 条目和第三方工具写的）永远不会被改动**。

同一个域名可以出现多行（默认 2 行）：**第一行是当前最优 IP，后面是备选**。Windows 的解析器会把同名多条**全部返回**，curl / 浏览器会**逐个尝试** —— 所以当第一条 IP 恰好抖动失效时，客户端会自动 fallback 到备选，不必干等下一轮健康检查。写几条由 `hosts.maxEntriesPerDomain` 控制。

---

## 5. 如何使用

> 平台：**Windows**；前置：**Node.js ≥ 18**。所有命令在 **PowerShell 或 cmd** 里执行。

### 方式一：npm 全局安装（推荐）

```bash
npm install -g ghprobe
```

装好后，两条命令即可：

```bash
ghprobe install     # 开启：探测并写入 hosts + 注册计划任务（全程只弹一次 UAC）
ghprobe uninstall   # 停止：删除计划任务并还原 hosts
```

**`ghprobe install` 做了什么：**

1. **生成用户配置文件** `%LOCALAPPDATA%\ghprobe\config.yaml`（已存在则**不覆盖**，保留你的改动）—— 候选池、超时、调度间隔、本地网络检查都在里面，可以直接编辑。
2. 先做一次**健康检查式的保守探测**：只测 hosts 里已写入的 IP，健康的保留、确认失效的才重排（不会把「本轮没抓到、但现有 IP 仍然健康」的域名误记成缺失）。若检测到**本地无网络**，本步自动跳过（必然全灭，跑了也白跑），但计划任务**照常注册**，有网后自动生效。
3. 弹出**一次 UAC**，在同一个管理员会话里完成两件事：
   - **写一次 hosts**：先把当前 hosts 备份为 `hosts.ghprobe-bak`，写入 ghprobe 块，校验块标记存在，失败自动回滚，成功则刷新 DNS 缓存。
   - **注册名为 `ghprobe` 的 Windows 计划任务**：以**最高权限（RunLevel=Highest）静默运行**（后续写入不再弹 UAC），按 `schedule.healthMin`（默认 1 分钟）的间隔执行 `health --apply`。任务动作经一个隐藏窗口包装器启动，**无窗口**，不打扰你。
   装完即用，此后不用再敲命令。

**`ghprobe uninstall` 做了什么：**

1. **还原 hosts**：把 ghprobe 的整块内容**剥掉**后写回 —— 只删 ghprobe 自己的行，**第三方条目一律保留**（刻意不用 `hosts.ghprobe-bak` 直接覆盖：那份备份是「写入前」的快照，直接覆盖会连带回滚后来由别的软件追加的条目），最后刷 DNS 缓存。
2. **删除计划任务**：`Unregister-ScheduledTask ghprobe`；任务本就不存在时幂等跳过。

   两步互相独立，任一步失败不影响另一步，失败时以非零退出码结束。

> 已发布到 npm：<https://www.npmjs.com/package/ghprobe>。也可从源码安装 —— 在仓库目录执行 `npm install -g .`。

### 方式二：克隆仓库一键部署

```bash
git clone https://github.com/zmw-zmw/ghprobe
cd ghprobe
```

然后双击 `install.cmd`，或在 PowerShell 里执行：

```powershell
.\install.ps1
```

`install.ps1` 会：自提权（**全程只弹一次 UAC**）→ 检查 Node 版本（≥ 18）→ 安装依赖 → 注册计划任务 → 立即写入一次 hosts → **自检并把结果打回当前窗口**。

可用开关：

```powershell
.\install.ps1                 # 部署：注册计划任务 + 立即写一次 hosts
.\install.ps1 -SkipProbe      # 只注册计划任务，等首轮健康检查自己写 hosts
.\install.ps1 -Uninstall      # 卸载：删除计划任务 + 还原 hosts
```

> `install.ps1` 还支持 `-LogFile <path>` 指定部署日志路径（默认 `%TEMP%\ghprobe-deploy.log`）；`-Inner` 是脚本内部自提权用的，不用手动传。  
> `install.cmd` 只是 `install.ps1` 的 cmd 包装（等价，双击即用）。

### 其它命令

```bash
# 跑一轮探测并打印结果（不写 hosts）
ghprobe probe
ghprobe probe -j            # 以 JSON 输出（便于脚本消费）
ghprobe probe --apply       # 探测后写入系统 hosts（会弹 UAC，自动备份）

# 只生成 hosts 块文本并打印，你自己决定是否写入
ghprobe hosts

# 手动做一次健康检查（默认不写 hosts；检测到异常只预览）
ghprobe health
ghprobe health --apply      # 检测到异常时写入系统 hosts（会弹 UAC）

# 从 GitHub 官方 api.github.com/meta 更新候选池缓存（每天一次即可）
# 该 API 未认证限 60 次/小时，所以别频繁调；health 到点也会自动调，一般不用手动
ghprobe update-pool

# 打印用户配置文件与池缓存的路径（配置文件可直接编辑）
ghprobe config-path

# 本地 HTTP API（默认 127.0.0.1:8930）
ghprobe serve
#   POST /api/probe    立即触发一轮探测，返回摘要
#   GET  /api/status   最近一轮结果
#   GET  /api/hosts    当前生成的 hosts 块
#   GET  /api/config   当前生效的配置

# 所有命令都支持 -c / --config 指定用户配置覆盖
ghprobe probe -c my.yaml
```

### 配置文件在哪

`ghprobe install` 会生成一份**用户配置文件**，放在：

```
%LOCALAPPDATA%\ghprobe\config.yaml
```

（用 `ghprobe config-path` 可随时打印这个路径。）

它**优先级高于包内默认配置**，可以直接编辑：候选池、超时、调度间隔、目标域名、本地网络检查……都在里面。文件里带完整中文注释说明每个键。改完保存即可，下一轮 `health` 就生效 —— 不需要重装。

> 为什么不放在包目录：npm 全局安装时包目录位于 `node_modules` 下，npm 升级/重装会**整个换掉**，放那儿用户改动会被清掉。
>
> 已有用户配置时 `install` **不会覆盖它**（只在文件不存在时才从包内默认复制一份）。

### 配置覆盖

除了直接编辑用户配置文件，也可以用 `-c my.yaml` 传入一个**只写你想改的部分**的 YAML：对象属性（如 `timeouts` / `probe` / `serve` / `schedule`）是**递归合并**的，你只需写要改的子键。

优先级：`-c 指定的文件` > `%LOCALAPPDATA%\ghprobe\config.yaml` > 包内 `config.default.yaml`。

```yaml
# 例 1：只把 TLS 超时改成 3 秒，dohMs / httpMs 保持默认
timeouts:
  tlsMs: 3000

# 例 2：把哨兵间隔改成 5 分钟
schedule:
  healthMin: 5

# 例 3：换一批 DoH 端点（注意 host 填 IP、sni 填服务域名）
doh:
  - { name: alidns1, host: 223.5.5.5, sni: dns.alidns.com, path: /dns-query }

# 例 4：调整目标域名清单
domains:
  - github.com
  - raw.githubusercontent.com

# 例 5：关掉本地网络检查（断网时也照样跑，一般不需要）
networkCheck:
  enabled: false
```

完整的默认配置见仓库里的 `config.default.yaml`（键名、默认值、注释都以它为准），主要几项：

```yaml
ipPools:
  seed: [...]     # 最稳定的入口（GitHub 自租段），建议不要删：它也是拉 meta 的直连入口
  fastly: [185.199.108.133, 185.199.109.133, 185.199.110.133, 185.199.111.133]
  azure: [...]    # 会过期，靠下面的 poolUpdate 自动维护的 auto 池兜住

domainPools:
  github.com: [auto, seed, azure]
  codeload.github.com: [auto, seed, azure]
  objects.githubusercontent.com: [fastly]
  raw.githubusercontent.com: [fastly]
  gist.githubusercontent.com: [fastly]
  avatars.githubusercontent.com: [fastly]

poolUpdate:
  enabled: true
  intervalHours: 24       # 成功与失败同一档冷却（拉不到就等满一个周期，不反复重试）
  source: "https://api.github.com/meta"
  host: api.github.com
  sections: [web, api]
  maxIps: 48
  perBigNet: 4            # 大网段每个采样几个（/20 有 4096 个地址，不能全展开）
  timeoutMs: 8000

networkCheck:
  enabled: true
  probe: { host: 223.5.5.5, port: 443, timeoutMs: 2000 }

fallbacks:
  raw.githubusercontent.com: [cdn.jsdelivr.net]

timeouts: { dohMs: 5000, tcpMs: 2500, tlsMs: 6000, httpMs: 6000 }
probe: { maxCandidates: 8, maxPoolIps: 32, maxPerDomain: 4, concurrency: 10 }
hosts: { maxEntriesPerDomain: 2 }
serve: { host: 127.0.0.1, port: 8930 }
schedule:
  healthMin: 1            # 哨兵间隔（分钟）：只测已写入 IP，异常才触发全量
  absentCooldownHours: 1  # 缺失域名冷却（小时）：SNI 层封锁的域名全量也救不回，冷却内不重试
```


### 卸载 / 回滚与日志

```bash
ghprobe uninstall              # 删除计划任务 + 还原 hosts（只删自己的行）
```

如果你是用 `install.ps1` 部署的，也可以用 `.\install.ps1 -Uninstall`。

- **手动回滚 hosts**：写入前会备份到 `C:\Windows\System32\drivers\etc\hosts.ghprobe-bak`；但更推荐用 `ghprobe uninstall`（它按块剥离，不会误伤第三方后来追加的条目）。
- **健康检查日志**：`%LOCALAPPDATA%\ghprobe\ghprobe.log`。计划任务静默运行、stdout/stderr 都被丢弃，所以每轮结果会追加到这里（含 `action` / `reason` / `changed`），跑挂了能查。
- **用户配置**：`%LOCALAPPDATA%\ghprobe\config.yaml`（可编辑，见上一节）。
- **候选池缓存**：`%LOCALAPPDATA%\ghprobe\pool.cache.json`（`update-pool` 自动维护，不用手改）。
- **部署日志**：用 `install.ps1` 时默认写到 `%TEMP%\ghprobe-deploy.log`。

---

## 6. 兜底链：为什么 hosts 里会出现 cdn.jsdelivr.net / ghproxy.net

除了 `github.com` 这类主域名，ghprobe 还会给**被主机名封锁**的域名配一条**兜底链**：
主候选全灭时改探测替身域名，并把**当下能通的那个**写进 hosts。

**为什么必须换域名**：有一层封锁是「换 IP 修不了」的 —— 被拦的不是 IP，而是 TLS 握手里
ClientHello 的形态（实测数据见 §3「边界」）。这种时候换任何 IP 都没用，只能**换一个不被拦的入口域名**。
而 GitHub 的文件内容有几个等价入口：

```text
raw.githubusercontent.com/<user>/<repo>/<ref>/<path>   ← 原始入口（常被拦）
cdn.jsdelivr.net/gh/<user>/<repo>@<ref>/<path>         ← jsDelivr 公共 CDN，同一份内容
ghproxy.net/https://raw.githubusercontent.com/<...>    ← 第三方 GitHub 代理
```

**为什么配多个候选**：替身域名自己也会被封。实测同一时刻 `cdn.jsdelivr.net` 的 TCP 连得上、
但 TLS 被掐 —— 所以配置里给一组候选，探测时**挑当下能通的**（能通多个就都写上，客户端自己选）。
默认三个：

| 替身 | 类型 | 说明 |
| --- | --- | --- |
| `cdn.jsdelivr.net` | jsDelivr 公共 CDN（Cloudflare） | 路径映射 `/gh/<user>/<repo>@<ref>/<path>` |
| `ghproxy.net` | ⚠️ 第三方 GitHub 代理 | 请求会经过它的服务器 |
| `gh-proxy.com` | ⚠️ 第三方 GitHub 代理 | 同上 |

> ⚠️ **第三方代理能看到你请求了哪些文件。** 介意的话把这两条删掉，只留 `cdn.jsdelivr.net`。

行为与前提：

- 默认只有 `raw.githubusercontent.com` 配了兜底；`github.com` / `codeload.github.com` 从不走兜底。
- 只在主候选**全灭**时触发；有任一活 IP 就不探兜底。
- 写入的是**替身域名**的 IP —— 救的是「换域名」，不是「换 IP」。访问时要换成替身的 URL 形式。
- 替身**自带探测判据**（路径 + 响应里必须出现的内容），写在配置里而不是代码里 ——
  所以你可以自己加替身，不需要改源码：

```yaml
fallbacks:
  raw.githubusercontent.com:
    - cdn.jsdelivr.net
    # 自己加一个：第三关用 path + mustContain 验证「这个 IP 真的在提供这份内容」
    - { domain: my.mirror.example, path: "/gh/torvalds/linux@master/README", mustContain: ["Linux kernel"] }
```

不想要兜底就清空（`--config` 覆盖是递归合并，给空对象即可）：

```yaml
fallbacks: {}
```

```bash
ghprobe install -c my.yaml
```

---

## 7. 系统要求与常见问题

### 系统要求

- **操作系统：Windows**。写系统 hosts、UAC 提权、注册计划任务都是 Windows 专有能力。  
  （探测 / 排名 / DoH / HTTP API 等核心逻辑本身跨平台，CI 也在 ubuntu 上跑这部分；但在 Linux/macOS 上跑 `probe` 只能看结果，**不会也无法**写系统 hosts。）
- **Node.js ≥ 18**。
- 首次安装需要管理员权限（一次 UAC）。

### 常见问题

**Q：为什么需要管理员权限？**  
系统 hosts 文件（`C:\Windows\System32\drivers\etc\hosts`）只有管理员能写；注册以最高权限运行的计划任务也需要管理员。`ghprobe install` 把「写 hosts」和「注册任务」合并进**同一次 UAC**，所以全程只弹一次。

**Q：为什么有时候修不好？**  
工具只能找到**当前网络、当前时刻**可用的 IP。如果遇到的是 SNI 主机名黑名单（换 IP 修不了）或 IP 黑洞，可能所有候选都不可用。此时会命中兜底链（如果配了），或者触发全灭护栏 —— **保留旧 IP、不写空块**，绝不会硬塞一个错误 IP 进去。

**Q：会不会影响别的软件？**  
不会。它**只写 hosts 文件**，不装代理、不改系统代理设置、不劫持流量。而且只操作 `# === ghprobe begin/end ===` 之间属于它自己的那一块，**你原有的 hosts 条目和第三方工具写的条目都不会被改动**；卸载时也只剥掉自己的块。

**Q：为什么每个域名只写一条 IP？**  
Windows 对同一域名在 hosts 里只认第一条，写多条也不会轮询。所以 ghprobe 每个域名只写最优的一条；排名里的「备选」仅用于展示，不写入。

**Q：两次健康检查之间 IP 失效了怎么办？**  
每域名只写一条 IP，若它在两次检查之间失效，最坏中断时长 ≈ `schedule.healthMin`（默认 1 分钟）。这是 hosts 机制本身的限制，不是探测能规避的。

**Q：计划任务锁屏时会跑吗？**  
`install` 注册的任务 `LogonType` 为 `Interactive`，锁屏 / 注销 / 未登录状态下不会触发，登录后按间隔继续。

### 免责声明

本工具仅做 DNS 优选与连通性探测，**不提供、不包含、不协助**任何代理、隧道、流量转发或网络管控对抗能力。使用本工具产生的一切后果由使用者自行承担。请遵守你所在地区的法律法规。

---

## 更新日志

变更记录见 [CHANGELOG.md](CHANGELOG.md)。

## License

**ghprobe** 以 **GNU General Public License v3.0** 发布，授权范围为 **GPL-3.0-only**（SPDX 标识符：`GPL-3.0-only`）。

注意：**不是** `GPL-3.0-or-later`。本项目**刻意**只接受 GPL v3 这一个版本，不接受「或任何后续版本」——这是一次有意的版本锁定（例如为避免未来某个 GPL v4 的条款被自动适用于本作品）。请在再分发时遵循同样的版本锁定。

```
ghprobe — GitHub 直连优选：本地 DoH 解析 + TLS 证书终审探测 + hosts 生成（无代理）
Copyright (C) 2026 zmw

This program is free software: you can redistribute it and/or modify
it under the terms of the GNU General Public License as published by
the Free Software Foundation, version 3 of the License.

This program is distributed in the hope that it will be useful,
but WITHOUT ANY WARRANTY; without even the implied warranty of
MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
GNU General Public License for more details.

You should have received a copy of the GNU General Public License
along with this program.  If not, see <https://www.gnu.org/licenses/>.
```

你可以自由地运行、研究、修改和再分发本软件，但需满足 GPL-3.0 的以下条件：

- **开源传染（copyleft）**：分发本软件或其衍生作品时，必须一并提供完整对应源码，且衍生作品须以**相同协议**授权。
- **保留声明**：不得移除版权声明、许可声明与免责声明。
- **无担保**：作者不提供任何明示或默示担保（详见 GPL-3.0 第 15、16 条）。

完整协议文本见仓库根目录的 [`LICENSE`](LICENSE)。仓库地址：<https://github.com/zmw-zmw/ghprobe>。
