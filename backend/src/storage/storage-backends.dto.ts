import { Type } from 'class-transformer';
import {
  IsBoolean,
  IsIn,
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  Length,
  Max,
  Min,
} from 'class-validator';

export class CreateStorageBackendDto {
  @IsIn(['s3', 'webdav', 'gdrive'])
  type: 's3' | 'webdav' | 'gdrive';

  @IsString()
  @Length(1, 64)
  name: string;

  @IsObject()
  config: Record<string, unknown>;

  @IsObject()
  credential: Record<string, unknown>;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  weight?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(64)
  maxInflight?: number;

  @IsOptional()
  @IsBoolean()
  enabled?: boolean;

  @IsOptional()
  @IsString()
  @Length(0, 255)
  note?: string;
}

export class UpdateStorageBackendDto {
  @IsOptional()
  @IsString()
  @Length(1, 64)
  name?: string;

  @IsOptional()
  @IsObject()
  config?: Record<string, unknown>;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  weight?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(64)
  maxInflight?: number;

  @IsOptional()
  @IsBoolean()
  enabled?: boolean;

  @IsOptional()
  @IsString()
  @Length(0, 255)
  note?: string;
}

export class RotateStorageCredentialDto {
  @IsObject()
  credential: Record<string, unknown>;
}

export class SetDefaultStorageBackendDto {
  @IsIn(['telegram', 's3', 'webdav', 'gdrive'])
  backend: 'telegram' | 's3' | 'webdav' | 'gdrive';
}

export class GDriveOAuthClientDto {
  @IsString()
  @Length(1, 256)
  clientId: string;

  @IsString()
  @Length(1, 256)
  clientSecret: string;
}

export class GDriveAuthUrlDto {
  @IsString()
  @Length(1, 512)
  redirectUri: string;
}

export class GDriveCompleteAuthDto {
  @IsOptional()
  @IsString()
  @Length(1, 64)
  accountId?: string;

  @IsString()
  @Length(1, 512)
  code: string;

  @IsString()
  @Length(1, 512)
  redirectUri: string;

  @IsString()
  @Length(1, 64)
  name: string;
}
