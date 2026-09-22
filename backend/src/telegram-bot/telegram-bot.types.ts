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
