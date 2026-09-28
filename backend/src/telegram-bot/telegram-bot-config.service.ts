import { BadRequestException, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Request } from 'express';
import { ConfigCacheService } from '../common/services/config-cache.service';
import { isValidSiteOrigin, isValidTimeZone } from '../config/env-validation';
import {
  BOT_CONFIG_DEFAULTS,
  BOT_CONFIG_KEYS,
  BOT_CONFIG_LIMITS,
  TelegramBotRuntimeConfig,
} from './telegram-bot.types';

/**
 * Bot 配置服务：读/写「面板可调」配置（走 ConfigCacheService 热更新，env 兜底）。
 *
 * 站点域名解析优先级（R11 防 host 伪造）：
 *   1. 手动模式：面板配置的 linkDomain；
 *   2. 自动模式：APP_URL（运维可信，D15）→ 受信代理头（仅 TRUST_PROXY_HOPS 正确时）；
 *   3. 以上均不可用 → fail-closed（返回 null，调用方拒绝签发并提示管理员配置）。
 *   绝不回退 localhost 或裸 Host 头。
 */
@Injectable()
export class TelegramBotConfigService {
  constructor(
    private readonly configCacheService: ConfigCacheService,
    private readonly configService: ConfigService,
  ) {}

  /** 读取运行时配置（面板值优先，缺失时用 env 兜底） */
  async getConfig(): Promise<TelegramBotRuntimeConfig> {
    const [ttlRaw, limitRaw, tzRaw, modeRaw, domainRaw] = await Promise.all([
      this.configCacheService.get(
        BOT_CONFIG_KEYS.linkTtlHours,
        this.configService.get<string>('TELEGRAM_BOT_LINK_TTL_HOURS') || String(BOT_CONFIG_DEFAULTS.linkTtlHours),
      ),
      this.configCacheService.get(
        BOT_CONFIG_KEYS.dailyLimit,
        this.configService.get<string>('TELEGRAM_BOT_DAILY_LIMIT') || String(BOT_CONFIG_DEFAULTS.dailyLimit),
      ),
      this.configCacheService.get(
        BOT_CONFIG_KEYS.quotaTimezone,
        this.configService.get<string>('TELEGRAM_BOT_QUOTA_TIMEZONE') || BOT_CONFIG_DEFAULTS.quotaTimezone,
      ),
      this.configCacheService.get(
        BOT_CONFIG_KEYS.linkDomainMode,
        this.configService.get<string>('TELEGRAM_BOT_LINK_DOMAIN_MODE') || 'auto',
      ),
      this.configCacheService.get(
        BOT_CONFIG_KEYS.linkDomain,
        this.configService.get<string>('TELEGRAM_BOT_LINK_DOMAIN') || '',
      ),
    ]);

    const ttl = Number(ttlRaw);
    const limit = Number(limitRaw);
    return {
      linkTtlHours: Number.isSafeInteger(ttl) && ttl >= BOT_CONFIG_LIMITS.minTtlHours && ttl <= BOT_CONFIG_LIMITS.maxTtlHours
        ? ttl
        : BOT_CONFIG_DEFAULTS.linkTtlHours,
      dailyLimit: Number.isSafeInteger(limit) && limit >= BOT_CONFIG_LIMITS.minDailyLimit && limit <= BOT_CONFIG_LIMITS.maxDailyLimit
        ? limit
        : BOT_CONFIG_DEFAULTS.dailyLimit,
      quotaTimezone: isValidTimeZone(tzRaw) ? tzRaw.trim() : BOT_CONFIG_DEFAULTS.quotaTimezone,
      linkDomainMode: modeRaw.trim() === 'manual' ? 'manual' : 'auto',
      linkDomain: domainRaw.trim(),
    };
  }

  /**
   * 写入面板配置（后端为权威校验方，非法值直接 400）。
   * 仅更新传入的字段；返回更新后的完整配置。
   */
  async updateConfig(patch: Partial<TelegramBotRuntimeConfig>): Promise<TelegramBotRuntimeConfig> {
    const current = await this.getConfig();
    const next: TelegramBotRuntimeConfig = { ...current };
    const writes: { key: string; value: string; description: string }[] = [];

    if (patch.linkTtlHours !== undefined) {
      const ttl = Number(patch.linkTtlHours);
      if (!Number.isSafeInteger(ttl) || ttl < BOT_CONFIG_LIMITS.minTtlHours || ttl > BOT_CONFIG_LIMITS.maxTtlHours) {
        throw new BadRequestException(
          `直链有效期必须为 ${BOT_CONFIG_LIMITS.minTtlHours}–${BOT_CONFIG_LIMITS.maxTtlHours} 的整数（小时）`,
        );
      }
      next.linkTtlHours = ttl;
      writes.push({ key: BOT_CONFIG_KEYS.linkTtlHours, value: String(ttl), description: 'Bot 直链有效期（小时）' });
    }

    if (patch.dailyLimit !== undefined) {
      const limit = Number(patch.dailyLimit);
      if (!Number.isSafeInteger(limit) || limit < BOT_CONFIG_LIMITS.minDailyLimit || limit > BOT_CONFIG_LIMITS.maxDailyLimit) {
        throw new BadRequestException(
          `每日额度必须为 ${BOT_CONFIG_LIMITS.minDailyLimit}–${BOT_CONFIG_LIMITS.maxDailyLimit} 的整数`,
        );
      }
      next.dailyLimit = limit;
      writes.push({ key: BOT_CONFIG_KEYS.dailyLimit, value: String(limit), description: 'Bot 非白名单用户每日直链额度' });
    }

    if (patch.quotaTimezone !== undefined) {
      const tz = String(patch.quotaTimezone).trim();
      if (!isValidTimeZone(tz)) {
        throw new BadRequestException(`切日时区不是合法 IANA 时区名: ${tz}`);
      }
      next.quotaTimezone = tz;
      writes.push({ key: BOT_CONFIG_KEYS.quotaTimezone, value: tz, description: 'Bot 配额切日时区' });
    }

    if (patch.linkDomainMode !== undefined) {
      const mode = String(patch.linkDomainMode).trim();
      if (mode !== 'auto' && mode !== 'manual') {
        throw new BadRequestException('域名模式必须为 auto 或 manual');
      }
      next.linkDomainMode = mode;
      writes.push({ key: BOT_CONFIG_KEYS.linkDomainMode, value: mode, description: 'Bot 直链站点域名模式' });
    }

    if (patch.linkDomain !== undefined) {
      const domain = String(patch.linkDomain).trim();
      if (domain !== '' && !isValidSiteOrigin(domain)) {
        throw new BadRequestException('站点域名必须为 http(s)://host[:port] 形式，且不含路径、查询串或用户信息');
      }
      if (domain.length > BOT_CONFIG_LIMITS.maxDomainLength) {
        throw new BadRequestException(`站点域名长度不得超过 ${BOT_CONFIG_LIMITS.maxDomainLength}`);
      }
      next.linkDomain = domain;
      writes.push({ key: BOT_CONFIG_KEYS.linkDomain, value: domain, description: 'Bot 直链站点域名（手动模式）' });
    }

    if (writes.length > 0) {
      await this.configCacheService.setBatch(writes);
    }
    return next;
  }

  /** TRUST_PROXY_HOPS 是否已显式配置为可信代理层数（>=1） */
  private trustedProxyEnabled(): boolean {
    const raw = process.env.TRUST_PROXY_HOPS;
    if (raw === undefined || raw === '') return false;
    const hops = Number(raw);
    return Number.isFinite(hops) && hops >= 1;
  }

  /**
   * 从请求推导候选域名（仅采信可信来源；APP_URL 优先）。
   * 无可信来源时返回 null（fail-closed），绝不回退裸 Host 头或 localhost。
   */
  detectDomainFromRequest(req?: Request): string | null {
    const appUrl = (this.configService.get<string>('APP_URL') || '').trim();
    if (appUrl && isValidSiteOrigin(appUrl)) {
      return this.normalizeOrigin(appUrl);
    }
    if (!req) return null;
    if (!this.trustedProxyEnabled()) return null;
    // trust proxy 开启时 Express 的 req.protocol / req.hostname 已按可信链解析
    const proto = req.protocol === 'https' ? 'https' : req.protocol === 'http' ? 'http' : null;
    const host = (req.hostname || '').trim();
    if (!proto || !host) return null;
    const candidate = `${proto}://${host}`;
    return isValidSiteOrigin(candidate) ? this.normalizeOrigin(candidate) : null;
  }

  /**
   * 解析直链使用的站点 Origin（不含结尾斜杠）。
   * 返回 null 表示无可用可信域名，调用方必须 fail-closed 并提示管理员配置。
   */
  async resolveSiteOriginAsync(req?: Request): Promise<string | null> {
    const config = await this.getConfig();
    if (config.linkDomainMode === 'manual') {
      const manual = config.linkDomain.trim();
      return isValidSiteOrigin(manual) ? this.normalizeOrigin(manual) : null;
    }
    return this.detectDomainFromRequest(req);
  }

  private normalizeOrigin(origin: string): string {
    try {
      const url = new URL(origin);
      url.pathname = '';
      url.search = '';
      url.hash = '';
      return url.toString().replace(/\/$/, '');
    } catch {
      return origin.replace(/\/+$/, '');
    }
  }
}
