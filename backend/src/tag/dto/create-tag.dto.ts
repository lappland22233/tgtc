import { IsString, IsOptional, Length, Matches, IsNotEmpty } from 'class-validator';
import { Transform } from 'class-transformer';

/** 将 3 位 hex 颜色（#rgb）归一化为 6 位（#rrggbb），与实体默认格式保持一致 */
function normalizeHexColor(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  const m = value.trim().match(/^#([0-9a-fA-F])([0-9a-fA-F])([0-9a-fA-F])$/);
  if (m) {
    return `#${m[1]}${m[1]}${m[2]}${m[2]}${m[3]}${m[3]}`.toLowerCase();
  }
  return value.trim().toLowerCase();
}

export class CreateTagDto {
  // trim 归一化并禁止纯空白名
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @IsNotEmpty({ message: '标签名称不能为空' })
  @Length(1, 50)
  name: string;

  @Transform(({ value }) => normalizeHexColor(value))
  @IsOptional()
  @IsString()
  @Length(4, 7)
  @Matches(/^#[0-9a-fA-F]{3,6}$/, { message: 'color must be a valid hex color (e.g. #ff0000)' })
  color?: string;
}
