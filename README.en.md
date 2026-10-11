# ghprobe

[![ci](https://github.com/zmw-zmw/ghprobe/actions/workflows/ci.yml/badge.svg)](https://github.com/zmw-zmw/ghprobe/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/ghprobe.svg)](https://www.npmjs.com/package/ghprobe)
[![License: GPL-3.0-only](https://img.shields.io/badge/license-GPL--3.0--only-blue.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/node-%3E%3D18-brightgreen.svg)](package.json)
[![Platform](https://img.shields.io/badge/platform-Windows-0078d6.svg)](README.en.md#requirements-and-faq)

English | [简体中文](README.md)

**A Windows command-line tool that speeds up direct connections to GitHub: it measures the IPs that actually work on *your* network right now, writes them into your hosts file, and swaps them out automatically when they die. No proxy, no system proxy changes, no traffic hijacking.**

The problem it solves is concrete: GitHub direct connections are sometimes fast, sometimes dead, `git clone` / `git push` hang or time out, and the hosts list you copied off the internet is a static snapshot that nobody maintains — when an IP dies, nobody notices. ghprobe moves "finding a usable IP" onto your own machine, automates it, and gives it self-healing.

- **Windows** only (writing the system hosts file, UAC elevation, and registering a scheduled task are all Windows-only capabilities)
- Touches **the hosts file only** — installs no proxy / driver / service
- Requires **Node.js ≥ 18**
- License **GPL-3.0-only**, author **zmw**, repository <https://github.com/zmw-zmw/ghprobe>

## Quick start

```bash
npm install -g ghprobe
ghprobe install     # probe once + write hosts + register the per-minute health check (a single UAC prompt)
ghprobe uninstall   # stop: remove the scheduled task and restore hosts
```

Ready to use right away — you never touch the command line again. Full commands and configuration are in section 5, "Usage".

---

## 1. What it is

### What it actually does

In one sentence: **ghprobe uses local probing to pick the fastest, most usable IP for each GitHub-related domain, and writes a self-maintaining hosts block.**

A full round is: confirm the machine is online (offline → skip) → resolve candidate IPs via local DoH + the built-in pool (auto-refreshed from the official meta once a day) → run a "three-stage probe" on every candidate → rank by latency → write the best IP plus one spare per domain into hosts. After that, a scheduled task health-checks periodically and re-ranks to swap in fresh IPs when the old ones die.

It provides **no** proxy, tunnel, traffic forwarding, or protocol evasion, and it does **not** try to "break through" anything; as long as the path is reachable in the first place, it does three things: **prefer good IPs, reject false-alive nodes, and replace IPs automatically when they fail.**

### Core technical points

**① Local DoH resolution, bypassing system-DNS poisoning**

Candidates do not come from system DNS (which may be poisoned); they come over DoH (RFC 8484 wire format, with no UDP/53 path at all). The defaults are endpoints verified reachable from mainland China: Alibaba DNS (`223.5.5.5` / `223.6.6.6`) and DNSPod (`1.12.12.12`).

Key detail: **DoH endpoints are reached by IP directly, with SNI validation.** If reaching a DoH endpoint itself required resolving its hostname first, you would fall into the deadlock of "resolving the DoH hostname requires resolving first." So the config stores the endpoint's IP, and a `sni` field carries the service hostname for certificate validation (RFC 6066 forbids using an IP as SNI), for example:

```yaml
doh:
  - { name: alidns1, host: 223.5.5.5, sni: dns.alidns.com, path: /dns-query }
  - { name: alidns2, host: 223.6.6.6, sni: dns.alidns.com, path: /dns-query }
  - { name: dnspod,  host: 1.12.12.12, sni: doh.pub,        path: /dns-query }
```

Multiple endpoints are queried concurrently; successful answers are unioned and de-duplicated, then a built-in IP pool adds more candidates.

**② Three-stage probe: only an IP that passes all three is "alive"**

For each `(domain, candidate IP)`:

1. **TCP RTT** — open a connection on port 443 and measure baseline latency.
2. **TLS handshake + certificate SAN validation** — `rejectUnauthorized: true`, with `servername` set to the target domain (SNI). The certificate must contain the target domain; DNS poisoning cannot forge a valid certificate.
3. **HTTP application-layer final check** — send a real `GET` with `Host: <domain>` on a real business path, read back a small prefix of the body and validate: is the status code in the allow list, does the body contain error signatures, does it contain features the domain must have, is the 3xx redirect target within the whitelist.

**Why is stage 3 mandatory?** Because stage 2's certificate check cannot stop "false-alive IPs on shared CDNs." Example: a shared Fastly node such as `185.199.x.x` will return a **perfectly valid** certificate for `github.com` (the SAN really does match), yet the HTTP body is `Fastly error: unknown domain` — that IP does not serve `github.com` at all. A certificate-only check would treat such a "false-alive IP" as a good node and write it into hosts, so hosts looks successfully written while GitHub becomes *less* reachable. Stage 3 does the final judgment using the **real business path** and the **response content**, which is what filters it out (for the same reason, `codeload.github.com` is probed on the archive-download path, not the root, because the root may 301 back to the main site).

**③ The candidate pool follows GitHub's official ranges daily, and gives up gracefully when it can't**

The pool isn't just a static list hard-coded in config. Once a day (`poolUpdate.intervalHours`) ghprobe pulls the latest ranges from GitHub's official `api.github.com/meta`, expands them into candidate IPs and caches them locally for the `auto` pool. So even if GitHub's Azure ranges (`20.x` / `4.x`) shift, the pool keeps up by itself — of the 24 built-in Azure IPs, 4 are already no longer in the official web range.

Two details:

- **Pulling meta requires direct-IP + SNI**: `api.github.com`'s DNS is poisoned in China so a plain request gets no response — and this step happens precisely when there is no working IP yet, so it can only use the configured **seed pool** (`ipPools.seed`, GitHub's own `140.82.112.0/20`, unchanged for years) as the direct entry point. Seeds are tried **in parallel**; the first success returns immediately and the remaining in-flight requests are aborted.
- **No retry when it fails**: that API is unauthenticated and limited to **60 requests/hour**, so success and failure **share the same cooldown** (24h by default). If `api.github.com` is blocked at the SNI layer (no IP swap can fix that), retrying is pointless and just burns the rate limit — ghprobe simply carries on with the existing pool + DoH.

**④ No proxy**

It writes the hosts file, and nothing else. No proxy software, no system proxy settings changed, no drivers, no traffic hijacking. Uninstalling just strips ghprobe's own block out of hosts, leaving nothing behind.

**⑤ Fault layering (this is the project's value proposition)**

"GitHub is unreachable" has causes at different layers, and the fix differs per layer:

| Fault layer | Symptom | Fixable by "changing the IP"? |
| --- | --- | --- |
| **DNS poisoning** | resolves to a wrong / unreachable IP | ✅ Yes. Just switch to a correct IP |
| **SNI hostname blacklist** | the hostname itself is blocked — the SNI in the TLS handshake carries the blocked domain | ❌ No. No IP will help; only **changing the domain** works |
| **IP blackhole** | entire IP ranges are dropped | ✅ Yes. Switch to a working range |

**Hosts-only** tools/tutorials handle only the first layer and are helpless against the second (e.g. `raw.githubusercontent.com` being precisely RST). ghprobe handles the second layer with a dedicated **fallback chain** (see section 6), treating the "changing the IP can't fix it" case separately.

---

## 2. Pain points it solves

**Pain point 1: GitHub won't open, images won't load, `git clone` is slow**

`git clone` stalls at `Receiving objects`, `git push` times out, pages spin, and every image in a README is a broken icon — same repo, same network, works in the morning, dead at night. Because the usable IPs for each GitHub domain drift with region, ISP, and time of day, and the address system DNS hands you is often slow or broken.

**Pain point 2: the hosts list you copied is a static snapshot**

The "GitHub hosts accelerator" list you find online is a snapshot someone measured at one point in time. When an IP dies, nobody knows, and it never updates itself. You apply it once, it works for a few days, then it stops working and you go hunting for a new list — which is really just manually maintaining a table that is doomed to go stale.

**Pain point 3: many tools want a proxy / system proxy change / driver install**

To speed up GitHub you are asked to install a pile of things: a proxy client, a system-proxy toggle, a TUN/TAP driver, a background service… heavy, dirty, and it may change how your browser, IDE, and other software reach the network. You just want `git clone` to be a bit faster; you don't want the whole system's network path rewritten.

**Pain point 4: picking IPs by hand with `ping` / `curl` is guesswork — and the "alive" one may be fake**

A manual `ping` only proves an IP responds; it does not prove that the IP actually serves GitHub. A shared CDN node will hand you a valid TLS certificate but tell you `unknown domain` at the HTTP layer — your ping looks "fine," yet after writing it into hosts GitHub gets *worse*. Picking IPs by feel walks straight into this trap.

**Pain point 5: GitHub suddenly breaks after boot and you have to go dig up IPs yourself**

IPs usually die while you are not looking. With no automatic check, you only find out when "it stops working one day," and then you go dig manually. ghprobe self-heals on a schedule: it sits silently, and the moment a written IP fails it re-ranks and swaps in a new one — without you watching.

---

## 3. How it differs from similar projects

GitHub acceleration already has mature projects. They fall into three groups — here is where ghprobe stands, and what each approach costs:

|  | Static hosts snapshots<br>(e.g. GitHub520, ineo6/hosts) | Local proxy<br>(e.g. dev-sidecar) | **ghprobe** |
| --- | --- | --- | --- |
| How it works | The maintainer probes once and ships one hosts file to everyone | Install a local proxy that forwards requests to acceleration endpoints | Probes **your own network** and writes hosts only |
| Anything to install? | No | Yes — proxy / certificate, plus a **resident process** | No (just a scheduled task that runs once a minute and exits in seconds) |
| Changes the system proxy? | No | **Yes** | No |
| Where the IPs come from | Someone else's measurement — not necessarily best for you | N/A | DoH + the three-stage probe, run **on your machine** |
| When an IP dies | Wait for the maintainer to update | N/A | **Swapped automatically** (per-minute sentinel) |
| Can it spot "false-alive" IPs? | No | N/A | Yes — gate 3 validates against a real business path |
| Platform | Cross-platform | Windows / macOS / Linux | Windows |

The costs of each approach are real, not theoretical:

- **Static snapshots rot.** The IPs were measured at one point in time, from one vantage point — not necessarily best for *your* ISP; and once the maintainer stops updating, it is dead. `ineo6/hosts` content is frozen at 2023-03-08; `GitHub520`'s README says its server expires 2026-12-31 and asks for 831 CNY/year in sponsorship.
- **A local proxy has a system-level cost.** Proxy, certificate, resident process — it rewrites the network path for everything, when all you wanted was a faster `git clone`. `dev-sidecar`'s own README records that an early version, if you rebooted with it running, left you with no network at all.
- **A hosts manager only solves "how to edit"** — you still have to find the IPs yourself.

ghprobe's trade-off: **it only does "pick good IPs + maintain them", and never touches the system network path.** The cost is Windows-only, plus one UAC prompt at `install` time — after that a highest-privilege scheduled task runs silently.

### Limits: what it cannot fix

"GitHub is unreachable" is not one problem — it is four problems at four different layers. ghprobe only handles the first three:

| Fault layer | Symptom | Fixable by changing the IP? | ghprobe |
| --- | --- | --- | --- |
| **DNS poisoning** | resolves to a wrong / unreachable IP | Yes | Yes — DoH bypasses system DNS |
| **IP blackhole / churn** | connection timeout (`ERR_CONNECTION_TIMED_OUT`) | Yes | Yes — probing + per-minute self-healing |
| **False-alive IP** | TCP/TLS fine, HTTP returns 4xx | Yes | Yes — gate 3 validates the real business path |
| **ClientHello fingerprint blocking** | connection reset (`ERR_CONNECTION_RESET`) | **No** | **No** — see below |

The last layer needs its own explanation, because it is the most easily misunderstood. Measured (same IP `185.199.110.133`, same SNI `raw.githubusercontent.com`, same moment, 20 trials each):

| Client | Handshake success |
| --- | --- |
| `openssl s_client` | **20/20** |
| Node.js `tls.connect` | 5/20 |
| `curl` | 3/20 |

**Same IP, same hostname, only the client changes — and the success rate drops from 100% to 15%.** So the block keys on the **shape of the TLS ClientHello** (extension list, order, length) — not on the hostname itself, and not on the IP. Two consequences:

1. **Changing the IP cannot fix it** — only changing the domain can. That is why there is a **fallback chain**
   with **several alternative candidates** (the fallbacks get blocked too): see section 6.
2. **This tool's probe results do not fully represent your experience** — ghprobe is Node, and its TLS fingerprint differs from your browser's. Measured: `raw.githubusercontent.com` opens fine in a browser, while the Node probe gets `ECONNRESET` on every candidate. In that case the tool writes `# blocked` (not `# absent`), meaning **inconclusive** rather than "unreachable":

   ```text
   # blocked raw.githubusercontent.com 2026-10-11T10:27:09.367Z
   ```

   `# absent` = probed, genuinely no usable IP. `# blocked` = the local probe client got fingerprinted; your browser may well work.

**Fixing the fourth layer** requires packet-level techniques (TTL manipulation, decoy packets, TCP-layer desync), which need a kernel driver (tools like GoodbyeDPI). That directly conflicts with this project's "no driver, no system network path changes" trade-off, so it is **deliberately out of scope**. ghprobe's job is: **given the network you already have, pick the right IPs and keep them working.**

---

## 4. How it works

### Overall flow

```
                        ┌─────────────────────────────────────┐
                        │  config: domains + DoH endpoints +  │
                        │  IP pool                            │
                        └──────────────────┬──────────────────┘
                                           │
                          ┌────────────────▼────────────────┐
                          │  Local network check ──no net──▶ │  ← all candidates would
                          │  skip this round                 │    be dead anyway
                          └────────────────┬────────────────┘
                                           │online
                          ┌────────────────▼────────────────┐
                          │  (once a day) refresh pool from  │  ← no retry on failure;
                          │  official meta                   │    wait for next cycle
                          └────────────────┬────────────────┘
                                           │
                          ┌────────────────▼────────────────┐
                          │  Local DoH federation (concurrent,│  ← bypasses
                          │  IP direct-connect) + IP pool     │    system-DNS poisoning
                          │  → candidate IP list              │
                          └────────────────┬────────────────┘
                                           │
                          ┌────────────────▼────────────────┐
                          │         Three-stage probe        │
                          │  ① TCP RTT                       │
                          │  ② TLS handshake + cert SAN      │  ← blocks DNS poisoning
                          │  ③ HTTP application-layer check  │  ← blocks shared-CDN fakes
                          └────────────────┬────────────────┘
                                           │
                          all three passed? ──no──▶ mark failed, drop
                                           │yes
                          ┌────────────────▼────────────────┐
                          │  rank by score ascending, take   │
                          │  the best per domain             │
                          └────────────────┬────────────────┘
                                           │
                          ┌────────────────▼────────────────┐
                          │  live IP for primary domain? ──no──▶ probe fallback domains │  ← change domain to beat SNI blocking
                          └────────────────┬────────────────┘
                                           │
                          ┌────────────────▼────────────────┐
                          │  build hosts block (best + spare)│
                          └────────────────┬────────────────┘
                                           │
                          ┌────────────────▼────────────────┐
                          │  elevated write to hosts + flush │
                          │  DNS cache; all-dead guard runs  │
                          │  before writing                  │
                          └─────────────────────────────────┘
```

### How the three command paths relate

There is only one core pipeline (DoH → three-stage probe → ranking), used through three command paths:

- **`ghprobe probe`** — run one full probe, **without writing hosts** (add `--apply` to write). Good for first seeing what your network can measure.
- **`ghprobe health`** — health check: **only tests the IPs already written into hosts**. If everything is healthy it exits silently and touches nothing; only on failure does it trigger a full re-rank to swap IPs. This is what the scheduled task actually calls.
- **`ghprobe install`** — one-shot enable: runs a conservative health-check-style probe first, then in **a single UAC** both writes hosts and registers the scheduled task (which calls `health --apply` on a timer).

All three share the same rules when writing hosts (same block format, same all-dead guard), so a manual `probe --apply` and the scheduled `health --apply` never clobber each other.

### Scheduling model: a sentinel, with a full re-rank only on failure

A fixed "full re-run every N hours" is a mismatch: wasteful when the network is fine, too slow when it isn't. ghprobe uses **tiers** instead:

- **Sentinel tier (default every 1 minute)**: one `health` run probes only the **already-written IPs** in the hosts block (with `probe.concurrency` concurrency), finishing in under 2 seconds. If all are healthy it exits silently without touching hosts.
- **Heavy tier (triggered only on failure)**: a full probe (DoH re-resolution + all candidates through the three stages) runs only once an existing IP is confirmed dead.

The sentinel interval comes from `schedule.healthMin`, default **1 minute** (also the lower bound for a Windows Task Scheduler repetition interval). It is the **worst-case wait** for "IP dies → swapped out."

### Anti-jitter and safety design

- **All-fail predicate (only a total outage counts as network failure)**: the network is judged to be at fault (blackhole window) only when **all written IPs fail** and there are ≥ 2 entries; then nothing is written that round. As long as **any single entry is healthy**, the path is up, so the failing ones are just stale/dead IPs and a re-rank is triggered. (The earlier "majority failed → give up" predicate was proven to misfire: its denominator counted only written entries and was often as low as 3–4, so "3 stale + 1 healthy" was misjudged as an outage — not fixing when it should.)
- **All-dead guard**: before writing, if the new block has **no valid IP at all** while hosts still has old entries, the write is **refused and the old entries are kept**. This prevents a network blip of a few tens of seconds from wiping mappings that were working. `probe --apply` and `health --apply` share this guard.
- **Partial update + IP stickiness**: after a full re-rank, only domains that **actually differ** from the current hosts are updated; tiny score jitter on a healthy domain won't trigger an IP change (each change costs a DNS cache flush and invalidates connection pools).
- **Duplicate-entry fallback**: each domain gets its best IP **plus one spare** by default. Windows returns *all* same-name entries and clients try them one by one, so if the first IP happens to die mid-jitter, the browser / `git` automatically falls through to the spare — turning a "down for up to a minute" into "one extra connect timeout". Count is controlled by `hosts.maxEntriesPerDomain` (default 2; set 1 for the old single-entry behavior).
- **`# absent` cooldown**: domains present in config but absent from hosts (typically SNI-blocked domains that even a full run can't save) are recorded as a `# absent <domain> <timestamp>` comment inside the hosts block, and are not retried for `schedule.absentCooldownHours` (default 1 hour), so the heavy tier doesn't fire uselessly every minute.
- **Local offline → skip entirely**: each round starts with a local network check — ① is there an enabled, non-loopback interface; ② can we TCP-connect to a domestic baseline target (default `223.5.5.5:443`). If the machine is offline it **does not probe, does not refresh the pool, does not write hosts** — it only logs `action=skip reason=本地无网络连接`. Rationale: offline, every candidate is necessarily dead, so a round is pure waste, and the log gets flooded with "stuck / all-dead", mixing "this machine has no network" with "GitHub is blocked" and hiding the real fault. The baseline target is deliberately **not GitHub** — it only answers "can this machine get out", independent of whether GitHub is reachable.
- **Candidate pool refreshed daily**: pull the latest network ranges from GitHub's official `api.github.com/meta`, expand them into candidate IPs, cache them locally and feed the `auto` pool. Why: GitHub's Azure ranges change and the built-in `azure` pool goes stale (4 of 24 measured IPs were already gone). That API is unauthenticated and limited to **60 requests/hour**, so the interval can only be large (24h by default). If it gets blocked at the SNI layer (no IP swap can fix that), **a failure waits a full cycle too** — retrying is pointless there, so ghprobe just keeps working with the existing pool + DoH. Manual trigger: `ghprobe update-pool`, which ignores the interval.
- **Stateless**: the `# absent` cooldown table is encoded directly in the hosts block comments — it survives process restarts and cross-process runs with no extra state file.
- **Cross-process write lock**: `probe --apply` and the scheduled task may write hosts concurrently, so a lock file serializes them and avoids read-modify-write clobbering; if the lock can't be acquired the round is skipped and the next health check writes it.

### The hosts block looks like this

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

Everything between `# === ghprobe begin/end ===` is owned by ghprobe; repeated writes only replace what's inside the block. **Lines outside the block (your own hosts entries and anything a third-party tool wrote) are never touched.**

A domain may appear on several lines (2 by default): **the first line is the current best IP, the rest are spares**. Windows returns all same-name entries and curl / browsers try them one by one — so if the first IP happens to be dead, the client falls through to a spare instead of waiting for the next health check. Controlled by `hosts.maxEntriesPerDomain`.

---

## 5. Usage

> Platform: **Windows**; prerequisite: **Node.js ≥ 18**. Run all commands in **PowerShell or cmd**.

### Option 1: install from npm (recommended)

```bash
npm install -g ghprobe
```

Then two commands are all it takes:

```bash
ghprobe install     # start: probe + write hosts + register the scheduled task (a single UAC prompt)
ghprobe uninstall   # stop: remove the scheduled task and restore hosts
```

**What `ghprobe install` does:**

1. **Generates the user config file** `%LOCALAPPDATA%\ghprobe\config.yaml` (it **does not overwrite** an existing one, so your edits survive) — candidate pools, timeouts, scheduling interval and the local network check all live there, ready to edit.
2. Runs a **conservative health-check-style probe** first: it tests only the IPs already written into hosts, keeping the healthy ones and re-ranking only the confirmed-dead ones (so domains whose current IP is still healthy but weren't captured this round are not misrecorded as missing). If it detects **no local network**, this step is skipped automatically (everything would be dead anyway) but the scheduled task **is still registered**, and takes effect once you're back online.
3. Prompts for **a single UAC**, then in the same elevated session does two things:
   - **Writes hosts once**: backs up the current hosts to `hosts.ghprobe-bak`, writes the ghprobe block, verifies the block marker exists, rolls back automatically on failure, and flushes the DNS cache on success.
   - **Registers the Windows scheduled task named `ghprobe`**: it runs **silently at highest privileges (RunLevel=Highest)** (so later writes never prompt UAC again) and runs `health --apply` on the `schedule.healthMin` interval (default 1 minute). The task action is launched through a hidden-window wrapper, so it is **windowless** and does not disturb you.

   It's ready to use right away; you never touch the command line again.

**What `ghprobe uninstall` does:**

1. **Restores hosts**: **strips** the whole ghprobe block and writes it back — it removes only ghprobe's own lines and **keeps third-party entries untouched** (it deliberately does *not* overwrite from `hosts.ghprobe-bak`: that backup is a "before write" snapshot, and overwriting from it would also roll back entries later added by other software), then flushes the DNS cache.
2. **Removes the scheduled task**: `Unregister-ScheduledTask ghprobe`; idempotent when the task doesn't exist.

   The two steps are independent — a failure in either does not affect the other, and the process exits non-zero on failure.

> Published on npm: <https://www.npmjs.com/package/ghprobe>. You can also install from source — run `npm install -g .` inside the repository directory.

### Option 2: clone and one-click deploy

```bash
git clone https://github.com/zmw-zmw/ghprobe
cd ghprobe
```

Then double-click `install.cmd`, or run in PowerShell:

```powershell
.\install.ps1
```

`install.ps1` will: self-elevate (**a single UAC prompt in total**) → check the Node version (≥ 18) → install dependencies → register the scheduled task → write hosts once immediately → **self-check and print the result back to the current window**.

Available switches:

```powershell
.\install.ps1                 # deploy: register the scheduled task + write hosts once now
.\install.ps1 -SkipProbe      # register the scheduled task only; let the first health check write hosts
.\install.ps1 -Uninstall      # uninstall: remove the scheduled task + restore hosts
```

> `install.ps1` also supports `-LogFile <path>` to set the deploy log path (default `%TEMP%\ghprobe-deploy.log`); `-Inner` is used internally for self-elevation and should not be passed manually.
> `install.cmd` is just a cmd wrapper around `install.ps1` (equivalent, double-click to run).

### Other commands

```bash
# Run one probe round and print results (does not write hosts)
ghprobe probe
ghprobe probe -j            # output JSON (for scripting)
ghprobe probe --apply       # probe then write to system hosts (UAC prompt; automatic backup)

# Only build and print the hosts block; you decide whether to write it
ghprobe hosts

# Run a health check manually (does not write hosts by default; only previews on failure)
ghprobe health
ghprobe health --apply      # write to system hosts when a problem is detected (UAC prompt)

# Refresh the candidate pool from GitHub's official api.github.com/meta (once a day is enough)
# That API is limited to 60 requests/hour unauthenticated, so don't call it often.
# health also does this on schedule, so you rarely need it manually.
ghprobe update-pool

# Print the paths of the user config file and the pool cache (the config file is editable)
ghprobe config-path

# Local HTTP API (default 127.0.0.1:8930)
ghprobe serve
#   POST /api/probe    trigger one probe round, return a summary
#   GET  /api/status   latest result
#   GET  /api/hosts    current generated hosts block
#   GET  /api/config   effective config

# Every command supports -c / --config for a user config override
ghprobe probe -c my.yaml
```

### Where the config file lives

`ghprobe install` generates a **user config file** at:

```
%LOCALAPPDATA%\ghprobe\config.yaml
```

(`ghprobe config-path` prints this path at any time.)

It **takes priority over the built-in default config** and can be edited directly: candidate pools, timeouts, scheduling interval, target domains, local network check — all live there. The file ships with full comments (in Chinese) explaining every key. Save it and the next `health` round picks it up — no reinstall needed.

> Why not in the package directory: with a global npm install the package lives under `node_modules`, and npm upgrades/reinstalls **replace it entirely**, wiping your edits.
>
> If a user config already exists, `install` **will not overwrite it** (it only copies the built-in default when the file is missing).

### Configuration override

Besides editing the user config file directly, you can also pass a YAML file containing **only the parts you want to change** via `-c my.yaml`: object properties (such as `timeouts` / `probe` / `serve` / `schedule`) are **merged recursively**, so you only write the keys you want to change.

Priority: the file given by `-c` > `%LOCALAPPDATA%\ghprobe\config.yaml` > the built-in `config.default.yaml`.

```yaml
# Example 1: change only the TLS timeout to 3s; dohMs / httpMs keep their defaults
timeouts:
  tlsMs: 3000

# Example 2: change the sentinel interval to 5 minutes
schedule:
  healthMin: 5

# Example 3: use different DoH endpoints (note: host is an IP, sni is the service domain)
doh:
  - { name: alidns1, host: 223.5.5.5, sni: dns.alidns.com, path: /dns-query }

# Example 4: adjust the target domain list
domains:
  - github.com
  - raw.githubusercontent.com

# Example 5: turn off the local network check (run even when offline; rarely needed)
networkCheck:
  enabled: false
```

The full default config lives in `config.default.yaml` in the repo (that file is the source of truth for key names, defaults and comments). The main parts:

```yaml
ipPools:
  seed: [...]     # the most stable entry point (GitHub's own range); keep it — it's also the direct entry for pulling meta
  fastly: [185.199.108.133, 185.199.109.133, 185.199.110.133, 185.199.111.133]
  azure: [...]    # goes stale; the auto pool maintained by poolUpdate below covers it

domainPools:
  github.com: [auto, seed, azure]
  codeload.github.com: [auto, seed, azure]
  objects.githubusercontent.com: [fastly]
  raw.githubusercontent.com: [fastly]
  gist.githubusercontent.com: [fastly]
  avatars.githubusercontent.com: [fastly]

poolUpdate:
  enabled: true
  intervalHours: 24       # success and failure share one cooldown (a failed pull waits a full cycle, no retry storm)
  source: "https://api.github.com/meta"
  host: api.github.com
  sections: [web, api]
  maxIps: 48
  perBigNet: 4            # how many IPs to sample per big range (/20 holds 4096 addresses; never expand fully)
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
  healthMin: 1            # sentinel interval (minutes): test written IPs only, full re-rank on failure
  absentCooldownHours: 1  # missing-domain cooldown (hours): SNI-blocked domains can't be saved even by a full run
```

### Uninstall / rollback and logs

```bash
ghprobe uninstall              # remove the scheduled task + restore hosts (removes only its own lines)
```

If you deployed via `install.ps1`, you can also use `.\install.ps1 -Uninstall`.

- **Manual hosts rollback**: before each write the file is backed up to `C:\Windows\System32\drivers\etc\hosts.ghprobe-bak`; but `ghprobe uninstall` is preferred (it strips by block and won't harm third-party entries added later).
- **Health-check log**: `%LOCALAPPDATA%\ghprobe\ghprobe.log`. The scheduled task runs silently and both stdout/stderr are discarded, so each round's result is appended here (`action` / `reason` / `changed`) so you can investigate if something breaks.
- **User config**: `%LOCALAPPDATA%\ghprobe\config.yaml` (editable — see the previous section).
- **Pool cache**: `%LOCALAPPDATA%\ghprobe\pool.cache.json` (maintained by `update-pool`; don't edit by hand).
- **Deploy log**: with `install.ps1`, written to `%TEMP%\ghprobe-deploy.log` by default.

---

## 6. The fallback chain: why cdn.jsdelivr.net / ghproxy.net show up in hosts

Besides the primary domains like `github.com`, ghprobe maintains a **fallback chain** for
hostname-blocked domains: when every primary candidate is dead, it probes alternative entry
domains and writes **whichever works right now** into hosts.

**Why the domain has to change**: one layer of blocking cannot be fixed by changing the IP —
what is blocked is not the IP but the **shape of the ClientHello** in the TLS handshake
(measurements in section 3, "Limits"). No IP will help there; only a **different, unblocked
entry domain** will. GitHub file content has several equivalent entry points:

```text
raw.githubusercontent.com/<user>/<repo>/<ref>/<path>   <- the original (often blocked)
cdn.jsdelivr.net/gh/<user>/<repo>@<ref>/<path>         <- jsDelivr public CDN, same content
ghproxy.net/https://raw.githubusercontent.com/<...>    <- third-party GitHub proxy
```

**Why several candidates**: the fallback domains get blocked too. Measured at the same moment:
`cdn.jsdelivr.net` accepted TCP but had its TLS handshake cut. So the config ships a set of
candidates and the probe **picks whichever works right now** (if several work, all are written
and the client chooses). Three by default:

| Fallback | Type | Note |
| --- | --- | --- |
| `cdn.jsdelivr.net` | jsDelivr public CDN (Cloudflare) | path mapping `/gh/<user>/<repo>@<ref>/<path>` |
| `ghproxy.net` | third-party GitHub proxy | your requests go through their server |
| `gh-proxy.com` | third-party GitHub proxy | same |

> **A third-party proxy can see which files you requested.** Delete those two if that bothers
> you and keep only `cdn.jsdelivr.net`.

Behaviour and prerequisites:

- By default only `raw.githubusercontent.com` has a fallback; `github.com` / `codeload.github.com` never use one.
- It fires only when the primary candidates are **entirely dead** — any live IP and the fallback is never probed.
- What gets written is the **fallback domain's** IP: this rescues "change the domain", not "change the IP".
  You access it through the fallback URL form.
- Fallbacks carry their **own probe signature** (path + required response content), declared in config
  rather than code — so you can add your own without touching the source:

```yaml
fallbacks:
  raw.githubusercontent.com:
    - cdn.jsdelivr.net
    # Add your own: gate 3 uses path + mustContain to verify this IP really serves this content
    - { domain: my.mirror.example, path: "/gh/torvalds/linux@master/README", mustContain: ["Linux kernel"] }
```

To remove the fallback, empty it (`--config` merges recursively, so an empty object works):

```yaml
fallbacks: {}
```

```bash
ghprobe install -c my.yaml
```

---

## 7. Requirements and FAQ

### Requirements

- **OS: Windows.** Writing the system hosts file, UAC elevation, and registering a scheduled task are all Windows-only capabilities.
  (The core logic — probing / ranking / DoH / HTTP API — is cross-platform and CI runs it on ubuntu; but on Linux/macOS, `probe` only shows results and **will not and cannot** write the system hosts file.)
- **Node.js ≥ 18.**
- First install needs administrator rights (one UAC prompt).

### FAQ

**Q: Why does it need administrator rights?**
The system hosts file (`C:\Windows\System32\drivers\etc\hosts`) is writable only by administrators, and registering a highest-privilege scheduled task also requires it. `ghprobe install` combines "write hosts" and "register the task" into **a single UAC prompt**, so you only see one.

**Q: Why can't it always fix things?**
The tool can only find IPs usable **on your current network at the current moment**. If the problem is an SNI hostname blacklist (which changing the IP can't fix) or an IP blackhole, every candidate may be unusable. In that case it hits the fallback chain (if configured) or the all-dead guard — it **keeps the old IPs and never writes an empty block**, and never forces in a wrong IP.

**Q: Will it affect other software?**
No. It **only writes the hosts file** — no proxy, no system-proxy changes, no traffic hijacking. It operates only on the block between `# === ghprobe begin/end ===` that belongs to it, so **your existing hosts entries and third-party entries are never modified**; uninstall likewise strips only its own block.

**Q: How many IPs per domain?**
Two by default (`hosts.maxEntriesPerDomain`): the best IP plus one spare. Windows returns all same-name entries and clients try them in order, so the spare is a **real fallback** — if the first IP is dead, the client retries the second instead of failing outright. Set it to 1 for the old single-entry behavior.

**Q: What if an IP dies between two health checks?**
The client falls through to the spare entry, so the cost is one extra connect timeout rather than a hard failure. Without a spare, the worst-case interruption would be about `schedule.healthMin` (1 minute by default).

**Q: How do I upgrade?**
```powershell
npm install -g ghprobe@latest
```
The scheduled task runs a **fixed path** inside the npm global directory, and `npm install -g` replaces it in place — so the **next trigger (within a minute) picks up the new version**. No need to re-run `install`, no second UAC prompt.

**Does the config update too?** Yes. At `install` time a **snapshot** of the then-current default config is stored, and loading does a **three-way merge**:

- Keys you **never changed** (value still equals the snapshot) → follow the latest default
- Keys you **did change** → your value is kept
- Keys you added / keys newly added by a release → both kept

So improvements to defaults (say, new fallback candidates) reach you **automatically**, and your customisations are never overwritten. To see what differs: `ghprobe config-diff`.

> Note: users who installed before 0.1.2 have no snapshot; it is created on the next `ghprobe install`. Until then, use `ghprobe config-diff` and delete the keys you want to follow.

**Q: Does the scheduled task run while the screen is locked?**
The task registered by `install` uses `LogonType = Interactive`, so it won't fire while locked / logged off / not logged in; it resumes on the interval after logon.

### Disclaimer

This tool performs DNS preference selection and connectivity probing only. It does **not** provide, include, or assist with any proxy, tunnel, traffic forwarding, or network-control evasion capability. You are solely responsible for any consequences of using this tool. Please comply with the laws and regulations of your jurisdiction.

---

## Changelog

See [CHANGELOG.md](CHANGELOG.md).

## License

**ghprobe** is released under the **GNU General Public License v3.0**, licensed as **GPL-3.0-only** (SPDX identifier: `GPL-3.0-only`).

Note: this is **not** `GPL-3.0-or-later`. The project **deliberately** accepts only GPL v3 and *not* "or any later version" — an intentional version lock (for example, so that a future GPL v4's terms are never automatically applied to this work). Please keep the same version lock when redistributing.

```
ghprobe — GitHub direct-connect optimizer: local DoH resolution + TLS-verified probing + hosts generation (no proxy)
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

You are free to run, study, modify, and redistribute this software, subject to the GPL-3.0 conditions:

- **Copyleft**: when distributing this software or a derivative work you must provide the complete corresponding source and license the derivative under the **same license**.
- **Preserve notices**: you may not remove the copyright, license, or disclaimer notices.
- **No warranty**: the author provides no express or implied warranty (see GPL-3.0 sections 15 and 16).

The full license text is in [`LICENSE`](LICENSE) at the repository root. Repository: <https://github.com/zmw-zmw/ghprobe>.
