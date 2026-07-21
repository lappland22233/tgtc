import {
  IsString,
  IsOptional,
  IsUUID,
  IsInt,
  Min,
  Max,
  IsIn,
  IsNotEmpty,
  MaxLength,
} from 'class-validator';
import { Type } from 'class-transformer';

/**
 * 创建分享链接 DTO。
 * 前端调用：POST /api/shares，需登录。
 */
export class CreateShareDto {
  @IsString()
  @IsIn(['file', 'folder'], { message: 'targetType 必须是 file 或 folder' })
  targetType: 'file' | 'folder';

  @IsUUID('4', { message: 'targetId 必须是合法的 UUID' })
  targetId: string;

  /** 密码明文，可选；不传或为空表示公开分享 */
  @IsOptional()
  @IsString()
  @MaxLength(128, { message: '密码不能超过 128 个字符' })
  password?: string;

  /** 访问次数上限，-1 表示不限 */
  @IsOptional()
  @Type(() => Number)
  @IsInt({ message: '访问次数必须是整数' })
  @Min(-1, { message: '访问次数最小为 -1（无限制）' })
  @Max(1000000, { message: '访问次数最大为 1000000' })
  maxAccessCount?: number;

  /** 有效期（小时），null 表示永久；范围 1-720 小时（30 天） */
  @IsOptional()
  @Type(() => Number)
  @IsInt({ message: '有效期必须是整数' })
  @Min(1, { message: '有效期最小为 1 小时' })
  @Max(720, { message: '有效期最大为 720 小时（30 天）' })
  expiresIn?: number | null;
}

/** 更新分享设置 */
export class UpdateShareDto {
  @IsOptional()
  @IsString()
  @MaxLength(128)
  password?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(-1)
  @Max(1000000)
  maxAccessCount?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(720)
  expiresIn?: number | null;
}

/** 公开密码验证 DTO */
export class VerifyPasswordDto {
  @IsString()
  @IsNotEmpty({ message: '密码不能为空' })
  @MaxLength(128, { message: '密码不能超过 128 个字符' })
  password: string;
}
