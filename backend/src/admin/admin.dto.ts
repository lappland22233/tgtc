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

export class ConfigDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
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

export class UploadConfigDto {
  @IsOptional()
  @IsInt()
  @Min(1)
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
