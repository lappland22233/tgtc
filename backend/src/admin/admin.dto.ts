import {
  IsString,
  IsOptional,
  IsBoolean,
  IsIP,
  IsArray,
  ArrayMinSize,
  IsUUID,
  IsInt,
  Min,
  Max,
  ValidateNested,
  IsNotEmpty,
  IsDateString,
  IsIn,
} from 'class-validator';
import { Type } from 'class-transformer';

export class BanIPDto {
  @IsIP()
  ip: string;

  @IsOptional()
  @IsString()
  reason?: string;

  @IsOptional()
  @IsBoolean()
  permanent?: boolean;

  @IsOptional()
  @IsDateString()
  expiresAt?: string;
}

export class UnbanIPDto {
  @IsIP()
  ip: string;
}

export class BatchDeleteFilesDto {
  @IsArray()
  @ArrayMinSize(1)
  @IsUUID('4', { each: true })
  ids: string[];
}

export class ConfigDto {
  @IsString()
  @IsNotEmpty()
  key: string;

  @IsString()
  @IsNotEmpty()
  value: string;

  @IsOptional()
  @IsString()
  description?: string;
}

export class BatchConfigDto {
  @IsArray()
  @ArrayMinSize(1)
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

  @IsString()
  @IsNotEmpty()
  password: string;

  @IsString()
  @IsNotEmpty()
  from: string;
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
