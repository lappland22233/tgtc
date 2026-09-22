/** Telegram Bot 文件直链：共享类型与配置键定义。 */

/** 归一化后的 TG 身份三要素（授权与审计共用；身份一律以数字 ID 为准） */
export interface TelegramBotIdentity {
  /** TG 用户 ID（字符串存储，可能超 32 位） */
  telegramUserId: string;
  /** @username（用户可控，仅审计展示，绝不参与权限判定） */
  username: string | null;
  /** 显示名（first_name + last_name） */
  displayName: string | null;
}

/** 运行时配置（面板可热更新，env 兜底） */
export interface TelegramBotRuntimeConfig {
  /** 直链有效期（小时） */
  linkTtlHours: number;
  /** 非白名单用户每日签发额度 */
  dailyLimit: number;
  /** 切日时区（IANA） */
  quotaTimezone: string;
  /** 站点域名模式：auto 自动获取 / manual 手动设置 */
  linkDomainMode: 'auto' | 'manual';
  /** 手动模式下的站点域名（如 https://text.lappland.top） */
  linkDomain: string;
}

/** 面板可调配置的存储键（SystemConfig.key） */
export const BOT_CONFIG_KEYS = {
  linkTtlHours: 'TELEGRAM_BOT_LINK_TTL_HOURS',
  dailyLimit: 'TELEGRAM_BOT_DAILY_LIMIT',
  quotaTimezone: 'TELEGRAM_BOT_QUOTA_TIMEZONE',
  linkDomainMode: 'TELEGRAM_BOT_LINK_DOMAIN_MODE',
  linkDomain: 'TELEGRAM_BOT_LINK_DOMAIN',
} as const;

/** 长轮询 offset 的持久化键（重启不丢更新） */
export const BOT_UPDATE_OFFSET_KEY = 'TELEGRAM_BOT_UPDATE_OFFSET';

/**
 * `BOT_UPDATE_OFFSET_KEY` 的**归属标记**：记录该全局 offset 属于哪个 Bot（botId）。
 *
 * 为什么需要：池化模式下每个账号有自己的 offset 键；从单账号模式切到池化模式时，
 * 只有「该 offset 原本就属于这个账号」才能继承——把 A 账号的偏移套用到 B 账号
 * 会跳过 B 尚未消费的更新（入站文件永久丢失），所以不能简单地「谁大用谁」。
 */
export const BOT_UPDATE_OFFSET_OWNER_KEY = 'TELEGRAM_BOT_UPDATE_OFFSET_OWNER';

/** Token 展示前缀前缀（如 tgl_a1b2c3d4） */
export const BOT_TOKEN_PREFIX = 'tgl_';

export const BOT_CONFIG_DEFAULTS = {
  linkTtlHours: 4,
  dailyLimit: 5,
  quotaTimezone: 'Asia/Shanghai',
} as const;

export const BOT_CONFIG_LIMITS = {
  minTtlHours: 1,
  maxTtlHours: 720,
  minDailyLimit: 1,
  maxDailyLimit: 100000,
  maxDomainLength: 255,
} as const;

/**
 * 入站长轮询模式。
 *
 * - `disabled`：入站开关未开（`TELEGRAM_BOT_UPDATES_ENABLED != true`），不消费任何更新；
 * - `single`：账号池未生效，单消费者 + 单一 offset；
 * - `pooled`：账号池生效，每账号一个独立循环与独立 offset。
 *
 * 模式在**启动时**确定，运行期不重建循环（避免同一 Bot 出现两个消费者或重放旧更新）；
 * 运行期漂移经 `TelegramBotPollingSnapshot.modeDrift` 暴露为「需重启才生效」。
 */
export type TelegramBotPollingMode = 'disabled' | 'single' | 'pooled';

/**
 * 单账号入站循环快照（只读诊断）。
 *
 * `lastErrorSummary` 写入前必须已脱敏（URL 形态 + 字面 Token）并截断，
 * 绝不包含 Token、file_id 或原始上游地址。
 */
export interface TelegramBotPollingAccountSnapshot {
  accountId: string;
  /** 该账号循环是否仍在运行（进程内标志；关闭时置 false） */
  running: boolean;
  /** 该账号当前的 offset（池化下按账号独立） */
  offset: number;
  /** 成功轮询次数（进程内累计） */
  pollCount: number;
  /** 累计消费的更新条数（进程内累计） */
  updateCount: number;
  /** 连续失败次数（成功后清零） */
  consecutiveFailures: number;
  /** 最近一次成功返回 getUpdates 的时刻（毫秒） */
  lastPollAtMs: number | null;
  /** 最近一次失败时刻（毫秒） */
  lastErrorAtMs: number | null;
  /** 最近一次失败摘要（已脱敏、已截断；无失败为 null） */
  lastErrorSummary: string | null;
}

/** 启动后一次性行为自检结论 */
export interface TelegramBotPollingSelfCheck {
  /** 自检执行时刻（毫秒） */
  atMs: number;
  /** true = 至少成功轮询过一次；false = 疑似空转 */
  healthy: boolean;
  /** 人类可读结论（异常时含排查指引） */
  message: string;
}

/**
 * 入站长轮询运行态快照（只读诊断；绝不包含 Token / file_id / 原始 URL）。
 *
 * 为什么需要「行为自检」而不是只看 `running`：v1.5.3 的 P0 回归里
 * 「标志写错 → 循环条件恒假 → 循环体一次都不执行」时，`running` 之外没有任何
 * 可观测信号（无日志、无异常、offset 不推进）。因此用「有没有真的成功轮询过」
 * 这个事实来判断健康度。
 */
export interface TelegramBotPollingSnapshot {
  /** 入站开关是否开启（`TELEGRAM_BOT_UPDATES_ENABLED=true`） */
  enabled: boolean;
  mode: TelegramBotPollingMode;
  /** 是否处于消费态（单账号与池化两种模式都必须为 true） */
  running: boolean;
  /** 入站消费启动时刻（毫秒） */
  startedAtMs: number | null;
  /** 最近一次任一循环成功返回 getUpdates 的时刻（毫秒） */
  lastPollAtMs: number | null;
  /** 行为自检结论；null 表示尚未到自检时间或自检已关闭 */
  selfCheck: TelegramBotPollingSelfCheck | null;
  /** 启动后账号池状态发生变化 → 需重启才能切换入站模式 */
  modeDrift: { restartRequired: boolean; reason: string | null };
  /** 池化模式下的每账号循环；单账号模式为空数组 */
  accounts: TelegramBotPollingAccountSnapshot[];
}
