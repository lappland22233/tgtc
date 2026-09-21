import { Type } from 'class-transformer';
import {
  IsBoolean,
  IsInt,
  IsOptional,
  IsString,
  Length,
  Matches,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

/** 账号调度参数上限（防止一次配置把单实例打进限流） */
export const ACCOUNT_LIMITS = {
  minWeight: 1,
  maxWeight: 100,
  minInflight: 1,
  maxInflight: 64,
  maxNameLength: 64,
  maxNoteLength: 255,
  maxChatIdLength: 32,
} as const;

/** Bot Token 形态：`<botId>:<secret>`（与 env 校验一致） */
export const BOT_TOKEN_PATTERN = /^\d+:[\w-]{10,}$/;

/** 创建 Bot 账号（创建即校验：getMe + 主存储 Chat 可访问性） */
export class CreateBotAccountDto {
  @IsString()
  @Length(1, ACCOUNT_LIMITS.maxNameLength)
  name: string;

  @IsString()
  @Matches(BOT_TOKEN_PATTERN, { message: 'Bot Token 形态非法（应为 <botId>:<secret>）' })
  @MaxLength(200)
  token: string;

  @IsOptional()
  @IsString()
  @MaxLength(ACCOUNT_LIMITS.maxChatIdLength)
  primaryChatId?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(ACCOUNT_LIMITS.minWeight)
  @Max(ACCOUNT_LIMITS.maxWeight)
  weight?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(ACCOUNT_LIMITS.minInflight)
  @Max(ACCOUNT_LIMITS.maxInflight)
  maxInflight?: number;

  @IsOptional()
  @IsString()
  @MaxLength(ACCOUNT_LIMITS.maxNoteLength)
  note?: string;
}

/**
 * 创建用户账号（MTProto）。
 *
 * 只接受 API ID / API Hash 与手机号，**不接受明文 session 直接粘贴长期保存**：
 * session 必须由服务端交互式授权产生并加密保存。
 */
export class CreateUserAccountDto {
  @IsString()
  @Length(1, ACCOUNT_LIMITS.maxNameLength)
  name: string;

  @Type(() => Number)
  @IsInt()
  @Min(1)
  apiId: number;

  @IsString()
  @Length(8, 128)
  apiHash: string;

  @IsOptional()
  @IsString()
  @MaxLength(32)
  phoneNumber?: string;

  @IsOptional()
  @IsString()
  @MaxLength(ACCOUNT_LIMITS.maxNoteLength)
  note?: string;
}

/** 更新账号（启停、备注、权重、并发、主存储 Chat） */
export class UpdateTelegramAccountDto {
  @IsOptional()
  @IsString()
  @Length(1, ACCOUNT_LIMITS.maxNameLength)
  name?: string;

  @IsOptional()
  @IsBoolean()
  enabled?: boolean;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(ACCOUNT_LIMITS.minWeight)
  @Max(ACCOUNT_LIMITS.maxWeight)
  weight?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(ACCOUNT_LIMITS.minInflight)
  @Max(ACCOUNT_LIMITS.maxInflight)
  maxInflight?: number;

  @IsOptional()
  @IsString()
  @MaxLength(ACCOUNT_LIMITS.maxChatIdLength)
  primaryChatId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(ACCOUNT_LIMITS.maxNoteLength)
  note?: string;
}

/** 轮换 Bot 凭据（旧凭据立即失效，不回显旧值） */
export class RotateBotCredentialDto {
  @IsString()
  @Matches(BOT_TOKEN_PATTERN, { message: 'Bot Token 形态非法（应为 <botId>:<secret>）' })
  @MaxLength(200)
  token: string;

  @IsOptional()
  @IsString()
  @MaxLength(ACCOUNT_LIMITS.maxChatIdLength)
  primaryChatId?: string;
}

/** 轮换用户账号凭据（重新授权：替换 API 凭据并重启授权流程） */
export class RotateUserCredentialDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  apiId?: number;

  @IsOptional()
  @IsString()
  @Length(8, 128)
  apiHash?: string;

  @IsOptional()
  @IsString()
  @MaxLength(32)
  phoneNumber?: string;
}

/**
 * 统一轮换入口（按账号类型解释字段）：
 * - Bot 账号：必须给 `token`，可选 `primaryChatId`；
 * - 用户账号：给 `apiId` / `apiHash` / `phoneNumber` 重启交互式授权。
 */
export class RotateAccountCredentialDto {
  @IsOptional()
  @IsString()
  @Matches(BOT_TOKEN_PATTERN, { message: 'Bot Token 形态非法（应为 <botId>:<secret>）' })
  @MaxLength(200)
  token?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  apiId?: number;

  @IsOptional()
  @IsString()
  @Length(8, 128)
  apiHash?: string;

  @IsOptional()
  @IsString()
  @MaxLength(32)
  phoneNumber?: string;

  @IsOptional()
  @IsString()
  @MaxLength(ACCOUNT_LIMITS.maxChatIdLength)
  primaryChatId?: string;
}

/** 用户账号授权：发送验证码 */
export class StartUserAuthDto {
  @IsOptional()
  @IsString()
  @MaxLength(32)
  phoneNumber?: string;

  @IsOptional()
  @IsBoolean()
  forceSMS?: boolean;
}

/** 用户账号授权：提交验证码（与可选 2FA 密码；两者都不入库不入日志） */
export class VerifyUserAuthDto {
  @IsString()
  @Length(3, 12)
  code: string;

  @IsOptional()
  @IsString()
  @MaxLength(128)
  password?: string;
}

/** 能力开关（账号池 / 镜像） */
export class SetFeatureSwitchDto {
  @IsBoolean()
  enabled: boolean;
}
