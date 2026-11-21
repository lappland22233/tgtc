import { Transform, Type } from 'class-transformer';
import { IsIn, IsInt, IsISO8601, IsOptional, IsString, Length, Matches, Max, Min } from 'class-validator';

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
