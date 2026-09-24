/**
 * 多账号（Bot 账号池）类型定义。
 *
 * 设计边界：
 * - 本模块是**可选增强**：`TELEGRAM_ACCOUNT_POOL_ENABLED != true` 时全部走原单账号链路，
 *   行为与改造前完全一致（可安全回退）；
 * - 账号标识（id）必须稳定：默认取 bot token 的数字前缀（= botId），便于与日志/台账对齐；
 * - **严禁把 token 写进日志/错误信息**：对外只暴露 `id` 与 `tokenPreview`。
 */

/** 单个账号的静态配置（来自 TELEGRAM_ACCOUNT_POOL / TELEGRAM_BOT_TOKENS） */
export interface TelegramAccountConfig {
  /** 稳定标识：默认 token 前缀（botId），也可显式指定 */
  id: string;
  /** Bot Token（敏感；只在内存与请求头中出现） */
  token: string;
  /** 该账号上传/接收的目标 chat（通常为归档群或与用户的私聊） */
  chatId: string;
  /** 静态权重（默认 1；可按机房/线路质量调大） */
  weight: number;
  /** 每账号在飞上限（默认 8；实验结论：8–16 区间成功率最佳） */
  maxInflight: number;
  /** 是否参与调度（默认 true；运维可临时摘除某账号） */
  enabled: boolean;
  /**
   * 每账号**大文件**（>1GiB）回源并发槽位（默认 1）。
   *
   * 为什么必须有：`FILE_DOWNLOAD_MAX_CONCURRENT_UPSTREAMS` 是**全局权重预算**，
   * 它保证不了「多个 4GB 冷流不要落到同一个账号」——当某分卷只有该账号持有 ready 副本
   * 时，全局预算再宽也只能压垮它（生产现象：全部 4GB+ 分卷副本集中在单一账号，
   * 该账号独自承受 DC-5 回源压力并频繁 FLOOD_WAIT）。该槽位按账号设闸，
   * 是「分散回源压力」在选号与准入两处的落点。
   *
   * 说明：`1` 表示同一账号同时只跑一个大文件冷回源；多账号部署下总并发
   * ≈ 持份账号数，而不是全局权重预算数。
   */
  maxLargeInflight?: number;
  /** 备注（如机房/线路，便于报告与排障；不含敏感信息） */
  note?: string;
  /**
   * 配置来源：`env`=环境变量引导（进程启动时固定）；`panel`=后台账号管理（数据库，可热更新）。
   * 用于把「面板账号集合」与「env 引导账号」分开刷新：刷新只替换 panel 项，env 项保持不变。
   */
  source?: 'env' | 'panel';
  /**
   * 是否为环境变量配置的「主 Bot」（`TELEGRAM_BOT_TOKEN`）。
   *
   * 语义：
   * - 主 Bot 始终注册在账号池内（后台可见、可探测、参与调度），但**后台只读**：
   *   密钥轮换只能改 `.env`，不接受后台编辑/删除；
   * - 同一 Token 已由 `TELEGRAM_ACCOUNT_POOL` / `TELEGRAM_BOT_TOKENS` 显式配置时，
   *   只给该条打 `primary` 标记，不重复注册（防双重轮询/双重计数）。
   */
  primary?: boolean;
}

/** 账号运行期状态（进程内，重启即重置） */
export interface TelegramAccountRuntime {
  config: TelegramAccountConfig;
  /** 当前在飞请求数（上传/下载都计入） */
  inflight: number;
  /**
   * 当前在飞的大文件（>1GiB）**回源**数。
   *
   * 为什么必须单独记账：全局权重预算（`FILE_DOWNLOAD_MAX_CONCURRENT_UPSTREAMS`）只约束
   * 全站总权重，无法阻止多个 4GB 冷流同时落到同一个账号——而 `file_id` 是账号隔离的，
   * 当某文件只有该账号持有 ready 副本时，全局预算再大也只能压垮它。该计数与
   * `maxLargeInflight` 一起构成「每账号大文件回源槽位」，是避免单账号独扛 DC-5 的闸门。
   */
  largeInflight: number;
  /**
   * 当前在飞的复制（副本扩散）请求数。
   *
   * 复制只能是下载的「副产品」：它同样消耗该账号的上游额度与出网带宽，
   * 因此单独记账并按比例限制，保证下载优先。
   */
  replicationInflight: number;
  /** EWMA 实测带宽（字节/秒）；未探测过为 0 */
  bandwidthEwmaBps: number;
  /** EWMA 成功率（0..1，初值 1） */
  successEwma: number;
  /** EWMA 探测延迟（毫秒）；未探测过为 0 */
  latencyEwmaMs: number;
  /** 连续失败次数（成功即清零，用于指数冷却） */
  consecutiveFailures: number;
  /** 冷却截止时间（毫秒时间戳；0 表示不冷却） */
  cooldownUntilMs: number;
  /** 统计：累计字节 / 累计请求 / 累计失败 / 最近一次错误摘要（已脱敏） */
  totalBytes: number;
  totalRequests: number;
  failures: number;
  lastErrorKind: AccountFailureKind | null;
  lastErrorAtMs: number;
  /** 最近一次成功时间（毫秒时间戳） */
  lastSuccessAtMs: number;
}

/** 失败分类：决定冷却时长（限流类最长） */
export type AccountFailureKind = 'flood' | 'unavailable' | 'timeout' | 'network' | 'other';

/**
 * 一次占用账号额度的用途。
 *
 * 为什么要区分：三类用途共享同一个账号的上游额度与出网带宽，必须能分别记账与限额——
 * - `download`：用户下载回源（最高优先级，不可被复制挤占）；
 * - `replication`：副本扩散（取源 + 重传，只能是下载的「副产品」）；
 * - `upload`：镜像/上传（与下载同属前台业务）。
 */
export type AccountAttemptRole = 'download' | 'replication' | 'upload';

/** 准入被拒的原因（可诊断，直接用于日志与告警文案） */
export type AccountAdmissionDenyReason =
  /** 账号不在池内（归属不明，必须 fail-closed） */
  | 'unknown_account'
  /** 账号已被运维禁用（尊重下线意图） */
  | 'disabled'
  /** 账号处于限流/失败冷却中 */
  | 'cooling_down'
  /** 已达每账号在飞上限 */
  | 'inflight_full'
  /** 已达每账号大文件回源槽位 */
  | 'large_inflight_full'
  /** 已达每账号复制并发上限（下载优先：复制让位给下载） */
  | 'replication_full';

/** 一次已授予的账号额度（必须 finish/release，二者幂等） */
export interface AccountAttemptAdmission {
  readonly accountId: string;
  readonly role: AccountAttemptRole;
  readonly largeFile: boolean;
  /** 归还额度并按样本更新带宽/健康画像（幂等；重复调用只有首次生效） */
  finish(sample?: AccountAttemptSample): void;
  /** 仅归还额度、不产生样本（客户端主动取消，不得据此进入冷却） */
  release(): void;
}

/** 准入结果：`granted=false` 时带可诊断原因与建议重试间隔 */
export interface AccountAdmissionResult {
  granted: boolean;
  reason?: AccountAdmissionDenyReason;
  /** 建议等待（毫秒）：冷却剩余或最小退避，供上层返回 Retry-After */
  retryAfterMs?: number;
  admission?: AccountAttemptAdmission;
}

/** 准入请求 */
export interface AccountAdmissionRequest {
  accountId: string;
  /** 用途（默认 download） */
  role?: AccountAttemptRole;
  /** 预计文件大小（字节）：>1GiB 视为大文件，占用每账号大文件槽位 */
  bytes?: number;
  /** 服务关闭中禁止新准入（由调用方传入的只读判定） */
  shuttingDown?: boolean;
}

/** 一次请求的采样结果（由调用方在请求结束后回报） */
export interface AccountAttemptSample {
  ok: boolean;
  /** 成功时的传输字节数（用于带宽 EWMA） */
  bytes?: number;
  /** 成功时的耗时（毫秒，用于带宽 EWMA） */
  durationMs?: number;
  /** HTTP 状态码（若可得） */
  status?: number;
  /** Telegram 返回的 retry_after（秒，限流时可得） */
  retryAfterSeconds?: number;
  /** 失败分类 */
  failureKind?: AccountFailureKind;
  /** 错误摘要（**必须已脱敏**；仅保留首 200 字符） */
  errorMessage?: string;
}

/** 选择结果 */
export interface AccountSelection {
  accountId: string;
  score: number;
  /** 供排障/报告使用的可解释原因 */
  reason: string;
}

/**
 * 账号池计数（进程内，与单实例约束一致）。
 * 用途：诊断接口、灰度前后对比、以及「回退率 / 全池不可用 / 复制持续失败 / 回复失败」的告警判定。
 */
export interface AccountPoolCounters {
  /** 按负载选号次数（含最终失败的尝试） */
  selections: number;
  /** 单次回源内的失败换号次数 */
  failovers: number;
  /** 池化失败后回退到「源账号」的次数 */
  fallbacks: number;
  /** 归属无法确认（sourceAccountId 为空或不在池内）的可诊断失败次数 */
  unresolved: number;
  /** 副本扩散成功次数 */
  replicationsOk: number;
  /** 副本扩散失败次数 */
  replicationsFailed: number;
  /** 流式回源失败次数 */
  streamFailures: number;
  /** 入站回复失败次数（收到消息的账号发送失败；绝不改用其它账号代发） */
  replyFailures: number;
  /** 入站副本登记失败次数（含缺失 file_unique_id 而拒绝登记） */
  inboundRegistrationFailures: number;
  /**
   * 用户账号中继成功次数（策略 B：一次服务端转发 → 各账号由入站链路自行登记副本）。
   * 与 `replicationsOk` 区分：后者是「逐账号重新上传」的策略 A。
   */
  userRelaysOk: number;
  /** 用户账号中继失败次数（未配置/无账号/源不可读/执行失败，随后回退策略 A） */
  userRelaysFailed: number;
  /**
   * 用户账号中继**已成功但无人认领**的次数（中继后等待窗口内没有任何账号登记新副本）。
   *
   * 为什么必须单独计数：中继成功只证明「消息转发到了群里」，**不等于**任何 Bot 拿到了
   * `file_id` 并登记 ready 副本——群内 Bot 未加入 / 隐私模式开启 / 轮询未开启时，
   * 中继会「看起来成功」但副本数为 0。历史实现里这条路径直接 return，扩散被静默跳过。
   */
  relayClaimsMissed: number;
  /**
   * 入站副本**未能**匹配到站内逻辑文件（反查 `files.telegramFileUniqueId` 未命中）。
   *
   * 这是**正常现象**而非故障：备份群/归档群里存在大量与站内文件无关的消息。
   * 单独计数是为了在排障时能区分「桥接没生效」与「本来就没有对应站内文件」。
   */
  inboundBridgeMisses: number;
  /**
   * 入站锚点**多义**次数（同一 `(chatId, messageId)` 命中多个逻辑主键）。
   *
   * 计数意义：双写（`fileUnique` + `file`）是合法的，但**同一入站消息**出现多个
   * 不同逻辑主键说明归属存在歧义。这类数据的表现是「候选副本集合在命名空间之间漂移」，
   * 单独计数让它可被审计发现，而不是只在日志里一闪而过。
   */
  anchorConflicts: number;
  /**
   * 源账号兜底被**应急配额**拒绝的次数（冷却中 / 达每账号大文件槽位 / 服务关闭）。
   *
   * 与 `fallbacks` 区分：后者是「成功走了源账号回退」，本计数是「本该回退但被限流保护拦下」。
   * 它上升说明源账号正处于限流冷却，继续硬打只会延长冷却。
   */
  fallbackThrottled: number;
  /**
   * 每账号大文件（>1GiB）回源槽位被占满而排队/拒绝的次数。
   *
   * 用于验证「大文件并发不再由全局预算单独决定」是否真的生效：若该计数长期为 0
   * 而同一账号同时有多个 4GB 冷流，说明槽位闸门没有命中，需要检查权重计算。
   */
  largeFileSlotThrottled: number;
}

export type AccountPoolCounterKey = keyof AccountPoolCounters;

/** 单个账号的运行态快照条目（脱敏，永不含 Token 原文） */
export interface AccountPoolAccountSnapshot {
  id: string;
  tokenPreview: string;
  chatId: string;
  enabled: boolean;
  weight: number;
  maxInflight: number;
  inflight: number;
  /** 当前在飞的大文件（>1GiB）回源数 */
  largeInflight: number;
  /** 每账号大文件回源槽位（>1GiB 的冷回源并发上限） */
  maxLargeInflight: number;
  /** 当前在飞的复制（副本扩散）请求数 */
  replicationInflight: number;
  bandwidthMbps: number;
  successRate: number;
  latencyMs: number;
  coolingDown: boolean;
  cooldownRemainingMs: number;
  consecutiveFailures: number;
  totalRequests: number;
  failures: number;
  totalBytes: number;
  lastErrorKind: AccountFailureKind | null;
  note?: string;
  /** 配置来源：env=环境变量引导；panel=后台账号管理（热更新） */
  source?: 'env' | 'panel';
  /** 是否为环境变量配置的主 Bot（后台只读、不可编辑/删除） */
  primary: boolean;
  /** 是否配置了存储 Chat（未配置时只能参与下载回源，不会被选为上传/镜像目标） */
  storageConfigured: boolean;
}

/** 账号池快照（管理端/日志/实验采集用；不含 token） */
export interface AccountPoolSnapshot {
  /** 是否处于「可用的池化模式」（启用 + 至少一个账号） */
  enabled: boolean;
  /** `enabled=false` 时的可诊断原因（区分「服务健康」与「账号池已启用但未生效」） */
  inactiveReason: string | null;
  /** 进程内计数（选择/换号/回退/复制/回复失败等） */
  counters: AccountPoolCounters;
  accounts: AccountPoolAccountSnapshot[];
}
