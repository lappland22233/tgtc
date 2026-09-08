import { ArrayMaxSize, IsArray, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';
import { Transform } from 'class-transformer';

/** 归一化名称：trim 后为空视为未提供 */
const normalizeName = ({ value }: { value: unknown }) =>
  typeof value === 'string' && value.trim() === '' ? undefined : value;

export class CreateApiKeyDto {
  @IsOptional()
  @Transform(normalizeName)
  @IsString({ message: '密钥名称必须是字符串' })
  @MinLength(1, { message: '密钥名称不能为空' })
  @MaxLength(64, { message: '密钥名称不能超过 64 个字符' })
  name?: string;
}

export class RotateApiKeyDto {
  @IsOptional()
  @Transform(normalizeName)
  @IsString({ message: '密钥名称必须是字符串' })
  @MinLength(1, { message: '密钥名称不能为空' })
  @MaxLength(64, { message: '密钥名称不能超过 64 个字符' })
  name?: string;
}

/** IP 白名单规则：单 IP（IPv4/IPv6）或 CIDR；空数组 = 清空 = 不限制 */
export class SetApiKeyAllowlistDto {
  @IsArray({ message: 'IP 规则必须是数组' })
  @ArrayMaxSize(100, { message: 'IP 规则数量过多' })
  @IsString({ each: true, message: 'IP 规则必须是字符串' })
  @Transform(({ value }) => (Array.isArray(value) ? value.map((v: unknown) => String(v).trim()).filter(Boolean) : value))
  rules: string[];
}
