import {
  IsString,
  IsOptional,
  IsBoolean,
  IsIP,
  IsArray,
  ArrayMinSize,
  ArrayMaxSize,
  IsUUID,
  IsInt,
  Min,
  Max,
  MaxLength,
  ValidateNested,
  IsNotEmpty,
  IsDateString,
  IsIn,
  IsEmail,
  ValidateIf,
  Matches,
  registerDecorator,
  ValidationArguments,
  ValidationOptions,
} from 'class-validator';
import { Type } from 'class-transformer';

function IsFutureDate(validationOptions?: ValidationOptions) {
  return (object: object, propertyName: string) => {
    registerDecorator({
      name: 'isFutureDate',
      target: object.constructor,
      propertyName,
      options: validationOptions,
      validator: {
        validate(value: unknown) {
          return typeof value === 'string'
            && Number.isFinite(Date.parse(value))
            && Date.parse(value) > Date.now();
        },
        defaultMessage(args: ValidationArguments) {
          return `${args.property} 必须晚于当前时间`;
        },
      },
    });
  };
}

export class BanIPDto {
  @IsIP()
  ip: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string;

  @IsOptional()
  @IsBoolean()
  permanent?: boolean;

  @ValidateIf((dto: BanIPDto) => dto.permanent === false)
  @IsDateString()
  @IsFutureDate({ message: '临时封禁到期时间必须晚于当前时间' })
  expiresAt?: string;
}

export class UnbanIPDto {
  @IsIP()
  ip: string;
}

export class BatchDeleteFilesDto {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(500)
  @IsUUID('4', { each: true })
  ids: string[];
}

/** 文件体检请求（Telegram file_id 有效性校验） */
export class FileVerifyDto {
  /**
   * dry-run：仅统计，不修改数据（默认）；
   * apply：执行校验并按结果标记 error / 回填 telegramFilePath。
   */
  @IsOptional()
  @IsIn(['dry-run', 'apply'])
  mode?: 'dry-run' | 'apply' = 'dry-run';

  /**
   * true：校验全部 ready 文件；false（默认）：仅校验 telegramFilePath 为空 的候选文件。
   */
  @IsOptional()
  @IsBoolean()
  allReady?: boolean = false;

  /** 单次最大检查数量，防止占满数据库连接池或触发 Bot API 限流 */
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(2000)
  limit?: number = 500;

  /** 并发校验数 */
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(8)
  concurrency?: number = 4;
}

/** 存量旧路径清理请求 */
export class StalePathCleanupDto {
  /**
   * dry-run：仅统计命中旧路径数量，不修改任何记录（默认）；
   * apply：清空匹配旧路径的 telegramFilePath 为 NULL（幂等）。
   */
  @IsOptional()
  @IsIn(['dry-run', 'apply'])
  mode?: 'dry-run' | 'apply' = 'dry-run';
}

export class ConfigDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  // 拒绝安全规则键（sec_*）与敏感凭据键，防止通过通用配置端点绕过安全校验或写明文密码
  @Matches(
    /^(?!sec_|SMTP_PASSWORD$|TELEGRAM_BOT_TOKEN$|JWT_SECRET$|COOKIE_SECRET$|DB_PASSWORD$)[A-Z][A-Z0-9_]*$/,
    { message: '不允许通过通用配置端点修改安全规则键或敏感凭据键' },
  )
  key: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(10000)
  value: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  description?: string;
}

export class BatchConfigDto {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(100)
  @ValidateNested({ each: true })
  @Type(() => ConfigDto)
  configs: ConfigDto[];
}

export class SmtpConfigDto {
  @IsString()
  @IsNotEmpty()
  host: string;

  @IsInt()
  @Min(1)
  @Max(65535)
  port: number;

  @IsBoolean()
  secure: boolean;

  @IsString()
  @IsNotEmpty()
  user: string;

  // 留空/未传时保留数据库中已有密码，避免 GET 不回显密码后无法二次保存
  @IsOptional()
  @IsString()
  @MaxLength(500)
  password?: string;

  @IsString()
  @IsNotEmpty()
  from: string;
}

export class SmtpTestDto {
  @IsEmail()
  recipient: string;
}

/** G7-07：/admin/files 分页查询 DTO（page/limit 带类型转换与上限校验） */
export class AdminFilesQueryDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number = 1;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number = 20;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  keyword?: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  userId?: string;

  @IsOptional()
  @IsString()
  @IsIn(['originalName', 'createdAt', 'size', 'uploader.email'])
  sortBy?: string;

  @IsOptional()
  @IsString()
  @IsIn(['asc', 'desc'])
  sortOrder?: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  cursor?: string;
}

export class UploadConfigDto {
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(10 * 1024 * 1024 * 1024) // G7-08：上限 10GB（10 * 1024^3）
  maxFileSize?: number;

  @IsOptional()
  @IsString()
  @IsIn(['blacklist', 'whitelist'])
  fileTypeMode?: string;

  @IsOptional()
  @IsString()
  fileTypeFilter?: string;

  @IsOptional()
  @IsInt()
  @Min(-1)
  @Max(1000000)
  accessCountDefault?: number;

  @IsOptional()
  @IsInt()
  @Min(-1)
  @Max(1000000)
  accessCountMax?: number;
}

export class AuthConfigDto {
  @IsOptional()
  @IsBoolean()
  registrationEnabled?: boolean;

  @IsOptional()
  @IsBoolean()
  emailVerificationEnabled?: boolean;
}

export class AccessLogQueryDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number = 1;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number = 20;

  @IsOptional()
  @IsString()
  path?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  statusCode?: number;

  @IsOptional()
  @IsString()
  @IsIn(['1h', '24h', '7d', '30d'])
  timeRange?: string;

  @IsOptional()
  @IsDateString()
  startDate?: string;

  @IsOptional()
  @IsDateString()
  endDate?: string;
}

/** 安全规则配置项 */
export class SecurityConfigItemDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  key: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(10000)
  value: string;
}

/** 批量安全规则配置 */
export class SecurityConfigBatchDto {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(100)
  @ValidateNested({ each: true })
  @Type(() => SecurityConfigItemDto)
  configs: SecurityConfigItemDto[];
}
