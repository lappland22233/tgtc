import { Type } from 'class-transformer';
import { IsBoolean, IsIn, IsInt, IsOptional, IsString, Length, Max, MaxLength, Min } from 'class-validator';

/** 历史文件补偿镜像（dry-run 只评估不入队） */
export class StartBackfillDto {
  @IsIn(['dry-run', 'apply'])
  mode: 'dry-run' | 'apply';

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(5000)
  limit?: number;
}

/** 更新镜像规则（首发单规则：不存在则创建） */
export class UpdateMirrorRuleDto {
  @IsOptional()
  @IsString()
  @Length(1, 64)
  name?: string;

  @IsOptional()
  @IsString()
  @MaxLength(32)
  sourceChatId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(32)
  targetChatId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  preferredAccountId?: string;

  @IsOptional()
  @IsBoolean()
  includeWebUploads?: boolean;

  @IsOptional()
  @IsBoolean()
  includeBotInboundFiles?: boolean;
}
