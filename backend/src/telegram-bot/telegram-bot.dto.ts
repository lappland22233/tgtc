import { IsIn, IsInt, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';
import { Type } from 'class-transformer';
import { BOT_CONFIG_LIMITS } from './telegram-bot.types';

/**
 * 更新 Telegram Bot 配置（面板可调项）。
 * 后端为权威校验方：超出范围/格式非法的值一律 400（前端校验仅为体验优化）。
 */
export class UpdateBotConfigDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(BOT_CONFIG_LIMITS.minTtlHours)
  @Max(BOT_CONFIG_LIMITS.maxTtlHours)
  linkTtlHours?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(BOT_CONFIG_LIMITS.minDailyLimit)
  @Max(BOT_CONFIG_LIMITS.maxDailyLimit)
  dailyLimit?: number;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  quotaTimezone?: string;

  @IsOptional()
  @IsIn(['auto', 'manual'])
  linkDomainMode?: 'auto' | 'manual';

  @IsOptional()
  @IsString()
  @MaxLength(BOT_CONFIG_LIMITS.maxDomainLength)
  linkDomain?: string;
}
