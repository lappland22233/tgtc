# 下载与缓存

> 本文档由原 README 拆分而来；文中路径均相对仓库根。下载任务、排队与 Range 的对外契约见 [API.md](API.md)，部署侧超时与反代要求见 [deployment.md](deployment.md)。总索引见 [README](../README.md)。

---

## 缓存与回源

- 下载由后端代理，不向浏览器暴露 Telegram Bot Token 或原始文件地址
- 本地文件缓存默认上限 10 GB、最低剩余空间 1 GB、TTL 3 天，可在管理后台热更新
- 冷文件可通过二次开发的 Telegram Bot API 实时流端点边下载边构建缓存
- 同一文件并发冷下载只建立一个上游回源；各客户端从临时缓存独立跟随读取
- 缓存使用临时文件、大小校验和原子发布；失败会清理不完整文件
- 支持标准单区间 Range（closed / open-ended / suffix）：缓存命中直接返回 `206`；冷文件通过 build/spool follower 同样保持 `206`，断点续传可用
- 上游始终单路顺序回源，请求区间若尚未回源完成会等待补齐（并发多线程下载未回源部分无法立即应答）；非法或越界 Range 返回 `416` 而非静默回退 `200`

### 下载磁盘配额与排队

所有会新增本地占用的下载环节（正式缓存构建、临时中转、缓存预热）统一走同一套调度：

- **占用预测 → 预约 → 排队**：按文件大小预测峰值占比并先行预约；准入公式为「物理空闲 − 最低安全余量 − 其他任务未写入预约 ≥ 本次新增」，避免多个任务复用同一份空闲空间；
- **写入即核销**：每写入一段数据就把预约量核销同等额度，已落盘部分由文件系统反映，不做物理/逻辑双重扣减；
- **不抢占**：已获得预约的任务不会被新任务或配置热更新撤销；回收只作用于已发布且未被读取的旧缓存，绝不删除进行中的临时文件；
- **结构性不可行时降级直通（并非"无条件可下载"）**：完整暂存不可行（单文件超过缓存上限，或卷内空间结构性不足）时自动降级为受限缓冲直通（`FILE_DOWNLOAD_DIRECT_WINDOW_MB`，不写本地副本），保持 `206`/`416` 与首字节语义。但准入仍在：等待队列满返回 `429 DOWNLOAD_QUEUE_FULL`；非任务化的直接下载在 `FILE_DOWNLOAD_DIRECT_WAIT_SECONDS` 内拿不到资源返回 `503 DOWNLOAD_SERVER_BUSY` + `Retry-After`。因此不保证「任何时刻都能立即开始下载」；
- **排队可见**：`POST /api/files/:id/download-tasks` 返回是否可立即下载或排队原因（磁盘 / 上游 / 负载）、近似队列位置与建议重试间隔；前端据此展示全局下载队列指示器并支持取消（详见 `../API.md`）。

运维注意：本调度管理的是后端缓存卷（`tmp/Cache`）。自建 Telegram Bot API/TDLib 的 `--dir` 工作目录是**独立磁盘域**，两者位于同一物理卷时仍可能互相抢占，建议分卷部署并分别配置最低余量（`FILE_CACHE_MIN_FREE_DISK_GB` 与 `--workdir-min-free-bytes`）。

**容量规划**：缓存卷可用空间的最低要求为「最大并发数 × 4 GiB × 2」（并发口径 `FILE_DOWNLOAD_MAX_CONCURRENT_UPSTREAMS`，默认 8 时约 64 GiB），完整说明见 [deployment.md 环境要求](deployment.md#环境要求)。

### 回源权重预算、队列公平与内存治理

三个「权重/上限」概念必须分开，禁止互相换算：

| 配置/字段 | 层级 | 语义 |
|---|---|---|
| `telegram_accounts.weight` | 账号池 | 账号**选号**的静态得分系数（按最高分确定性选取，不是概率轮询；不影响全局预算） |
| `telegram_accounts.maxInflight` | 账号池 | 单 Bot 账号在飞请求上限（后台新建默认 16，可配置为 1-64）；环境变量 Bot 未显式配置时默认 16 |
| `FILE_DOWNLOAD_MAX_CONCURRENT_UPSTREAMS` | 下载资源协调器 | **全局上游回源权重预算**（不是连接数，也不是「账号数 × maxInflight」） |

- **权重映射**：`>1GiB` → 8、`256MiB–1GiB` → 2、其余小文件 → 1；权重超过预算时按预算裁剪。图床小文件严格 `<20,000,000 bytes` 不占每 IP 4 个公开媒体并发槽，但仍受 30 req/s 速率、全局预算、账号准入、队列和磁盘保护。
- **预算自动扩缩容**（`FILE_DOWNLOAD_AUTO_CAPACITY_ENABLED=true`，默认开启）：按**有效 Bot 数**映射 `min(64, max(8, n×16))`（1 个 → 16、2 个 → 32、4 个 → 64，上限 64）。升档仍需目标稳定 2 个周期、通过失败/冷却和 ≥1GiB 多账号副本闸门，每次最多 `+8`；降档仍有滞后和步长保护。「有效 Bot」= 同时满足 `enabled` + 已配置存储 Chat + 健康（未冷却、连续失败低于阈值）+ **该账号存在自己的 `status=ready` 副本**。闸门：升档需目标值连续 2 个评估周期稳定（60s/次）且窗口内无新增回源失败、无账号处于限流冷却；每次最多 `+8`；降档需目标持续偏低 10 个周期，每次最多 `-8`、永不低于 `8`；`有效 Bot = 0` 时挂起自动调整（无依据不缩容）。每次写入都会同时落审计日志（旧值/新值/有效 Bot 数/原因/来源）与运行日志。**任何调整都不撤销已授予的租约**，只影响后续准入。
- **队列等待策略**（`FILE_DOWNLOAD_UPSTREAM_QUEUE_POLICY`，默认 `strict_fifo`）：
  - `strict_fifo`：严格 FIFO，队首权重不足时后续任务也不放行（紧急回退模式）；
  - `bounded_fit`：队首暂时放不下时，仅在队首之后的前 8 个等待项中按 FIFO 顺序放过可适配的任务；单个队首最多被绕过 8 次，或被绕过至等待超过 10 秒后进入「队首保留」，不再发放非队首任务（大文件不会被小任务饿死）。绕过次数、队首等待年龄与保留状态均可在运行快照中观测。
- **副本目标**（`TELEGRAM_POOL_TARGET_REPLICAS`，SystemConfig 热更新，1-8，默认 2）：**审计口径**——有效目标 = `min(配置值, 可承载副本账号数)`，无可承载账号时自动降为 1 并在运行快照中显示降级原因；Web 下载、Bot 公开下载与镜像回源共用同一解析结果。**扩散不再由下载触发，也不再由这个目标数驱动**：文件一经入库（Web 上传提交 / 主 BOT 收到私聊文件）即对每条匹配事件范围的启用镜像规则各建一条扩散任务（幂等键 = `ruleId + 归属对象 + 源版本`），重复触发与手动重试都不会产生重复消息。启用规则默认包含 Web 上传和 Bot 入站；迁移会将已启用且 Web 上传镜像开启的规则纳入 Bot 入站，管理员仍可显式关闭。**扩散只做服务端转发**：不存在跨逻辑文件的字节复制并发闸门，也不存在任何目标账号 claim 排队。
- **内存治理**：spool/build follower **每块数据独立分配** 256KiB 读缓冲，读取后直接把该块内存的视图交给下游（不再 `Buffer.from(subarray)` 复制），从而去掉「复用缓冲 + 每块一次拷贝」的双重分配。**禁止复用已 push 的缓冲**：经 `pipeline(stream, res)` 消费时，`res.write()` 会把缓冲留在 socket 写队列里（尚未刷入内核），复用同一块内存会造成下载内容被后一块静默覆盖——`readableLength === 0` 只说明数据已离开本流的内部缓冲，**不代表下游已释放**。direct 直通流显式使用**字节模式**（`objectMode:false`），窗口（`FILE_DOWNLOAD_DIRECT_WINDOW_MB`，1-4MiB，默认 1MiB）即单请求预读内存上限，与文件总大小无关。运行快照暴露 `rssBytes`/`heapUsedBytes`/`externalBytes`/`arrayBuffersBytes`、直通流数与窗口总量、follower 缓冲分配次数——`heapUsed` 无法反映 glibc 原生堆的扩张，必须结合这些进程级读数判断。

**发布顺序（手工步骤）**：

1. 上线「配置读取修复 + 运行时指标 + direct 字节模式 + follower 回归测试」，队列保持 `strict_fifo`；
2. 管理后台把直通窗口设为 `1 MiB`，观察 RSS 与吞吐；
3. 在账号池页「副本扩散策略」卡确认策略状态（仅用户账号中继）、跑一次**只读能力预检**，并观察覆盖率与缺失样例，**不立即提高期望副本数**；
4. 上传一个测试文件（提交即触发扩散，或在事件时间线对可重试轮次手动重试），确认至少两个可承载 Bot 均出现 ready 副本；
5. 低峰期切换 `bounded_fit`，观察队首等待、绕过次数、小文件 503 与大文件公平等待；
6. 稳定后扩大副本补齐范围；只有在可承载账号数与 Telegram 限流都允许时才提高期望副本数（4 不是默认值）。

**回滚开关**：队列异常 → 切回 `strict_fifo`（不改预算）；内存异常 → 直通窗口保持/降回 `1 MiB`；扩散异常 → **关闭镜像功能运行时开关 `TELEGRAM_MIRROR_FEATURE_ENABLED`（后台热更新：停止新任务与周期对账）或停用具体镜像规则**，必要时把期望副本数降为当前已就绪路数（不删除已有 ready 副本；**绝不启用任何二次上传**）。**注意**：`TELEGRAM_USER_RELAY_ENABLED` 是链路**前置条件**（构造期读取，重启生效），关闭它**不能**阻断已启用规则下的镜像任务执行，**不得**把它当作止血开关；Telegram 限流异常 → 关闭 `FILE_DOWNLOAD_AUTO_CAPACITY_ENABLED` 并维持当前预算（禁止直接手工翻倍）；配置展示异常 → 回退管理端 GET 变更，保留运行时安全区间与监控。

**发布阻塞条件**（任一命中都不得扩大流量或副本目标）：活跃权重超过预算或存在无法释放的租约；大文件在公平阈值内被持续绕过；账号池把没有对应 ready 副本的账号选为回源账号；`file_id` 归属校验失败；RSS/swap 随传输周期持续增长或 glibc `[heap]` 未形成平台；`FLOOD_WAIT`、中继失败（`relayFailed` / `RELAY_FAILURE_BURST`）或上游 503 显著高于基线。

**压测与观测场景**：① 2 个 4GiB 分卷并发（预算 16）混入多个 64MiB 以下小文件；② 16 个小文件持续回源（验证权重/账号在飞/direct 窗口）；③ 多个 follower 读取同一 spool（迟到、慢消费、断开重连、Range）；④ noCache 连续下载并重复 ≥3 个周期；⑤ 中继扩散与下载同时发生（观察 `relayAttempts`/`relayClaimsMissed` 与轮次记录是否成对增长）。Linux 侧额外采集 `/proc/<pid>/smaps_rollup`、`VmRSS`、`VmHWM`、swap 与 `[heap]` 段变化；验收阈值：固定并发下 RSS 在 10 分钟内回落到峰值 1.25 倍以内或形成平台，swap 不随周期线性增长。仅当代码侧治理完成后原生堆仍长期偏高，才在 canary 上单独验证 `MALLOC_ARENA_MAX` 等 allocator 参数（每次只改一个变量）。


## 下载超时分层

下载链路跨越多层，任何**外层**先于内层断开，都会让客户端只看到「无原因中断」而不是可分类的超时（历史 4GiB 分卷事件即由此放大）。因此各层超时必须满足 **内层 < 外层**。

层级链（与 `scripts/release/start.sh` 写入的 systemd 单元、`.env` 及 `backend/src/config/env-validation.ts` 注释一致）：

```text
首字节链：Bot API 首字节 120s < Nest HTTP 180s < 缓存首字节 210s
空闲链：  Bot API 空闲 120s   < 缓存空闲 150s   < Node 空闲 180s < Nginx read 210s
```

两条链互相独立：**首字节链**管「等第一个数据块」的阶段（冷文件需要 TDLib 先回源），
**空闲链**管「已经开始传输但长时间没有新数据」的阶段。两者都不设固定总时长。

对应的配置项与默认值：

| 层级 | 配置项 / 参数 | 默认值 | 作用 |
|---|---|---|---|
| 最内层：Bot API 首字节 | `--file-stream-first-byte-timeout` | `120`（秒） | TDLib 回源后首个字节到达上限 |
| Nest 上游请求 | `TELEGRAM_FILE_STREAM_TIMEOUT_SECONDS` | `180`（秒） | 后端请求实时流端点的读超时 |
| 缓存构建空闲 | `FILE_CACHE_BUILD_IDLE_TIMEOUT_MS` | `150000`（毫秒） | 传输中无数据则中止会话；**每收到数据即刷新** |
| 缓存构建首字节 | `FILE_CACHE_BUILD_FIRST_BYTE_TIMEOUT_MS` | `210000`（毫秒） | 冷启动允许 TDLib 更久才吐出首块 |
| 缓存构建总时限 | `FILE_CACHE_BUILD_TOTAL_TIMEOUT_MS` | `0`（禁用） | 需绝对上限的场景再显式开启，必须大于首字节超时 |
| Node HTTP 空闲 | `HTTP_IDLE_TIMEOUT_SECONDS` | `180`（秒） | 数据传输中不超时，仅空闲时生效 |
| 最外层：Nginx read | `proxy_read_timeout` | `210s` | 见 `nginx-download.conf.template`；**不得设置固定总时长** |

两条必须理解的原则：

- **内层必须小于外层**：`env-validation` 会对非法数值（非整数、负数）直接报错；对层级冲突（如首字节小于空闲、`HTTP_IDLE_TIMEOUT_SECONDS*1000` 不大于缓存空闲、总时限不大于首字节）只输出**高可见度告警**、不阻断启动，以免既有自定义部署升级失败。冲突时外层会先断开，表现为无法分类的 502/504。
- **总时限默认禁用（`0`）**：固定总时限不随进度刷新，会把速度低于约 **2.28 MiB/s** 的 4GiB 长传输直接误杀（4GiB ÷ 1800s ≈ 2.28MiB/s）。真正的卡死改由**首字节超时**与**有进度即刷新**的空闲超时来判定。


## 磁盘占用与清理

一次大文件下载会同时涉及多个磁盘域，需分别配置与监控：

| 位置 | 路径 | 默认策略 | 清理/准入 |
|---|---|---|---|
| 后端下载缓存 | `tmp/Cache` | 上限 `10GiB`、TTL `3` 天、LRU 淘汰 | 命中刷新；超上限按 LRU 淘汰；过期清理；管理后台可热更新 |
| TDLib workdir | `runtime/telegram-bot-api/data` | 清理阈值 `20GiB` / 目标 `15GiB` / 间隔 `3600s` / 文件 TTL `86400s` / 最低余量 `1GiB` | workdir 清理任务 + **写前空间准入** |
| Bot API 临时目录 | `runtime/telegram-bot-api/tmp` | `start.sh` 以 `--temp-dir` 显式落在受控路径 | 组件自身管理（默认 `/tmp` 会脱离 workdir 配额统计） |
| Nginx 代理临时卷 | `proxy_temp_path` / `client_body_temp_path` | 下载端点 `proxy_max_temp_file_size 0`（直通不落盘） | 模板声明 + 容量告警清单 |

- **workdir 中不可删除的是控制状态**：`db.sqlite*` 与 `td.binlog*`（以及 session）是 `file_id` 的绑定凭据，删除/清空/重命名会让历史 `file_id` 全部失效；**媒体副本本身可被回收**（可由 `file_id` 重新回源）。
- **bot 直链上游按引用计数回收 workdir 副本**：后端请求 bot 直链文件时携带 `X-Telegram-No-Cache`，流正常结束后，Bot API 在**无其他流监听者/下载监听者**时删除 TDLib workdir 中的本地副本（引用计数安全），使「Cache + workdir」两份完整副本收敛为一份；中断传输的行为与不带该头一致。
- **写前空间准入（fail-closed）**：开始为文件建立本地副本前检查「可用空间 − `workdir-min-free-bytes` ≥ 预计增量」；未知大小用 `--workdir-unknown-file-min-free-bytes`（默认 `512MiB`）。不满足时在首字节前返回结构化 **`507`**（JSON + 真实状态码），并计数告警。
- **缓存占用明细**：`GET /api/admin/download-runtime` 暴露 `buildBytes` / `spoolBytes` / `orphanBytes` / `orphanFiles` / `cleanupFailureTotal` / `cacheUsageScannedAt`。应用启动时与**每 6 小时**清理进程崩溃残留的 `.tmp` / `.spool`；`unlinkAllCacheFiles` 已改为前缀匹配（此前只删固定后缀，孤儿文件永不清）。


## Bot 直链断点续传

`GET /api/bot-dl/:token` 复用与站内下载**完全相同**的本地缓存 / Range 链路，断点续传契约如下：

- 完整下载返回 `200`（含 `Content-Length`、`Accept-Ranges: bytes`、强 `ETag`）；
- 单区间 Range 返回 `206`（含 `Content-Range`），且**与完整响应使用同一 ETag**；
- 稳定强 `ETag` = `sha256('telegram-bot:' + file_id + ':' + size)` 的十六进制摘要（带引号），不含明文凭据，同一 Telegram 文件跨不同直链保持一致；
- `If-Range` **仅在强 ETag 精确匹配时**才认 Range；弱标签（`W/"..."`）、版本不匹配、日期值一律**忽略 Range 回完整 `200`**，避免客户端把不同版本的分段拼成损坏文件；
- 越界与多区间 Range 仍返回 `416` + `Content-Range: bytes */<total>`（`416` 也携带 `ETag`）；
- 文件大小未知（Telegram 未上报）时**不声明 `Accept-Ranges`、不下发 `ETag`**，退化为完整 `200` 直通；
- **续传前提是链接仍在有效期内**：过期 / 已撤销 / 不存在统一 `404`，无法从旧链接续传。

冷文件的 Range 请求仍从 Telegram **偏移 0 顺序回源并写入本地缓存**，客户端请求的区间若尚未回源完成，由区间 follower **等待补齐**后再继续输出——**不是随机读取**，并发多线程下载尚未回源的部分无法立即应答（表现为等待，而不是报错或重复回源）。

`curl -C -` 自动断点续传示例：

```bash
curl -C - -OJ "https://your-domain.example/api/bot-dl/<token>"
```

完整的 200/206/416 响应头契约、`If-Range` 语义表与显式续传示例见 [API.md](API.md)。


## 下载端点反向代理要求

为避免代理侧再次放大占用、破坏 Range/`206` 语义或最先断开长传输：

- **模板**：`scripts/release/nginx-download.conf.template`（`/api/bot-dl/` 与 `/api/s/` 直通片段）——`proxy_buffering off`、`proxy_request_buffering off`、`proxy_cache off`、`proxy_max_temp_file_size 0`、`gzip off`、`proxy_read_timeout 210s`、不设固定总时长、Range/`If-Range` 透传、`map $uri $tgtc_redacted_uri` 日志脱敏、代理临时目录声明与容量告警清单。
- **部署自检**：`scripts/release/check-download-proxy.sh`——静态校验 Nginx 下载 location + 真实 HTTP 探针（`206` / `Content-Range` / `Accept-Ranges` / 强 `ETag` + `If-Range` 不匹配回 `200` + 磁盘余量阈值）；配套回归测试 `scripts/release/tests/check-download-proxy.test.sh`（16 用例）。
- **生产 Nginx 不在本仓库**，本模板只是片段，**实际应用由运维执行**；部署后必须运行自检脚本验收。

运维要点：

- **`TGTC_BOT_STATS_PORT` 为 opt-in**：`start.sh` 仅在设置了该变量时才给 Bot API 加 `--http-stat-port`（默认关闭）。开启后暴露的 stats 端点**必须自行限制为仅本机可访问**（绑定回环 / 防火墙 / 仅允许受控监控来源），不要直接暴露公网。
- **4GiB 分卷场景**建议将 `FILE_DOWNLOAD_DIRECT_WAIT_SECONDS` 上调到 `180`（仍须小于 Nginx `proxy_read_timeout` `210s`）。
- `start.sh` 会为 Bot API 生成 systemd 单元并写入 `.env`：显式传入首字节 `120s`、空闲 `120s`、最大连接 `100`、最大文件 `0`（不限）、workdir 清理阈值 `20GiB`/目标 `15GiB`/间隔 `3600s`/TTL `86400s`/最低余量 `1GiB`/未知大小余量 `512MiB` 与 `--temp-dir`。


