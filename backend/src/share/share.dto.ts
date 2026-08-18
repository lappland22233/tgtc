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
  Matches,
  MinLength,
} from 'class-validator';
import { Type, Transform as ClassTransform } from 'class-transformer';

/**
 * 分享密码强度约束（G5-08/G5-09 协同）：
 * - 至少 6 个字符（比账号密码略低，避免过度阻碍正常分享，但仍要求足够长度）；
 * - 必须至少包含两类字符（小写字母、大写字母、数字、特殊符号），
 *   杜绝纯数字/纯字母的弱密码被暴力破解。
 * 与服务端 SharePasswordService 的 token 失败累计锁定升级配合，显著提高爆破成本。
 */
export const SHARE_PASSWORD_MIN_LENGTH = 6;
/** 至少两类字符：小写、大写、数字、特殊符号 */
const SHARE_PASSWORD_CLASSES_PATTERN = /^(?:(?=.*[a-z])(?=.*[A-Z])|(?=.*[a-z])(?=.*\d)|(?=.*[a-z])(?=.*[^A-Za-z0-9])|(?=.*[A-Z])(?=.*\d)|(?=.*[A-Z])(?=.*[^A-Za-z0-9])|(?=.*\d)(?=.*[^A-Za-z0-9])).+$/;

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

  /** 密码明文，可选；不传或为空表示公开分享（空串经 Transform 归一为 undefined，跳过强度校验） */
  @IsOptional()
  @IsString()
  @ClassTransform(({ value }) => (typeof value === 'string' && value.trim() === '' ? undefined : value))
  @MinLength(SHARE_PASSWORD_MIN_LENGTH, { message: `密码至少 ${SHARE_PASSWORD_MIN_LENGTH} 个字符` })
  @Matches(SHARE_PASSWORD_CLASSES_PATTERN, { message: '密码需包含至少两类字符（字母、数字、特殊符号）' })
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
  @ClassTransform(({ value }) => (typeof value === 'string' && value.trim() === '' ? undefined : value))
  @MinLength(SHARE_PASSWORD_MIN_LENGTH, { message: `密码至少 ${SHARE_PASSWORD_MIN_LENGTH} 个字符` })
  @Matches(SHARE_PASSWORD_CLASSES_PATTERN, { message: '密码需包含至少两类字符（字母、数字、特殊符号）' })
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
