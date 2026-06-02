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
  @IsNotEmpty()
  allowedFileTypes?: string;
}

export class AuthConfigDto {
  @IsOptional()
  @IsBoolean()
  registrationEnabled?: boolean;

  @IsOptional()
  @IsBoolean()
  emailVerificationEnabled?: boolean;
}
