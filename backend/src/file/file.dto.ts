import { IsArray, ArrayMinSize, IsUUID, IsString, IsOptional, IsInt, Min, Max, IsIn, ValidateIf } from 'class-validator';
import { Type } from 'class-transformer';

export class BatchMarkdownDto {
  @IsArray({ message: 'ids 必须是数组' })
  @ArrayMinSize(1, { message: '至少需要选择 1 个文件' })
  @IsUUID('4', { each: true, message: '每个 id 必须是合法的 UUID v4' })
  ids: string[];
}

export class UpdateAccessTypeDto {
  @IsString()
  @IsIn(['public', 'private'], { message: '访问类型必须是 public 或 private' })
  accessType: string;
}

export class UpdateAccessCountDto {
  @Type(() => Number)
  @IsInt({ message: '访问次数必须是整数' })
  @Min(-1, { message: '访问次数最小为 -1（无限制）' })
  maxAccessCount: number;
}

export class SetPasswordDto {
  @IsString()
  password: string;
}

export class UpdateExpiresDto {
  @IsOptional()
  @ValidateIf(o => o.expiresIn !== null)
  @Type(() => Number)
  @IsInt({ message: '有效期必须是整数' })
  @Min(1, { message: '有效期最小为 1 小时' })
  @Max(720, { message: '有效期最大为 720 小时（30 天）' })
  expiresIn: number | null;
}
