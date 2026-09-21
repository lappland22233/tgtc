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
  /** 备注（如机房/线路，便于报告与排障；不含敏感信息） */
  note?: string;
}

/** 账号运行期状态（进程内，重启即重置） */
export interface TelegramAccountRuntime {
  config: TelegramAccountConfig;
  /** 当前在飞请求数（上传/下载都计入） */
  inflight: number;
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
}

export type AccountPoolCounterKey = keyof AccountPoolCounters;

/** 账号池快照（管理端/日志/实验采集用；不含 token） */
export interface AccountPoolSnapshot {
  /** 是否处于「可用的池化模式」（启用 + 至少一个账号） */
  enabled: boolean;
  /** `enabled=false` 时的可诊断原因（区分「服务健康」与「账号池已启用但未生效」） */
  inactiveReason: string | null;
  /** 进程内计数（选择/换号/回退/复制/回复失败等） */
  counters: AccountPoolCounters;
  accounts: Array<{
    id: string;
    tokenPreview: string;
    chatId: string;
    enabled: boolean;
    weight: number;
    maxInflight: number;
    inflight: number;
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
  }>;
}
