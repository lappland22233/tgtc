import { Transform, Type } from 'class-transformer';
import {
  IsIn, IsInt, IsISO8601, IsOptional, IsString, Length, Matches, Max, Min, ValidateIf,
} from 'class-validator';

const telegramId = /^[1-9]\d{0,19}$/;

export class BotOperationsUserParams {
  @Matches(telegramId)
  telegramUserId: string;
}

export class BotOperationsPage {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(1_000_000)
  page = 1;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  pageSize = 20;
}

export class BotOperationsTimePage extends BotOperationsPage {
  @IsOptional()
  @IsISO8601({ strict: true })
  from?: string;

  @IsOptional()
  @IsISO8601({ strict: true })
  to?: string;
}

export const BOT_USER_GROUP_SCOPES = ['queue', 'grants', 'audit'] as const;
export type BotUserGroupScope = typeof BOT_USER_GROUP_SCOPES[number];

export class BotUserGroupsQuery extends BotOperationsTimePage {
  @IsOptional()
  @IsIn([...BOT_USER_GROUP_SCOPES])
  scope: BotUserGroupScope = 'queue';

  @IsOptional()
  @Matches(telegramId)
  receiverBotId?: string;

  @IsOptional()
  @Transform(({ value }) => typeof value === 'string' ? value.trim() : value)
  @IsString()
  @Length(1, 64)
  keyword?: string;
}

export const BOT_OVERVIEW_RANGES = ['24h', '7d', '30d'] as const;
export type BotOverviewRange = typeof BOT_OVERVIEW_RANGES[number];

export class BotOverviewQuery {
  @IsOptional()
  @IsIn([...BOT_OVERVIEW_RANGES])
  timeRange: BotOverviewRange = '7d';
}

class BotOperationsFilters extends BotOperationsTimePage {
  @IsOptional()
  @Matches(telegramId)
  receiverBotId?: string;

  @IsOptional()
  @Matches(telegramId)
  telegramUserId?: string;
}

export class BotQueueQuery extends BotOperationsFilters {
  @IsOptional()
  @IsIn(['all', 'queued', 'running', 'completed', 'failed', 'cancelled'])
  status: 'all' | 'queued' | 'running' | 'completed' | 'failed' | 'cancelled' = 'all';
}

export class BotGrantsQuery extends BotOperationsFilters {
  @IsOptional()
  @IsIn(['all', 'active', 'expired', 'revoked'])
  status: 'all' | 'active' | 'expired' | 'revoked' = 'active';
}

export class BanTelegramUserDto {
  @Transform(({ value }) => typeof value === 'string' ? value.trim() : value)
  @IsString()
  @Length(1, 500)
  reason: string;
}

/**
 * 设置/清除单账号每日额度。
 *
 * `dailyLimit: null` 表示清除覆盖（回落通用额度）——与 Bot 侧
 * `/quota_set <ID> default` 语义一致，避免面板与命令两套行为。
 * 字段必填（即使是 null）：缺省会导致「什么都没改」却返回成功。
 */
export class SetUserQuotaDto {
  @ValidateIf((dto: SetUserQuotaDto) => dto.dailyLimit !== null)
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100000)
  dailyLimit: number | null;
}
