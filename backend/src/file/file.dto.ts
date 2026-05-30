import { IsInt, IsOptional, Min, Max, IsArray, ArrayMinSize, IsUUID } from 'class-validator';
import { Type } from 'class-transformer';

export class GenerateShareLinkDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt({ message: 'expiresIn 必须是整数' })
  @Min(1, { message: '过期时间最小为 1 小时' })
  @Max(24 * 30, { message: '过期时间最大为 720 小时（30 天）' })
  expiresIn?: number;
}

export class BatchMarkdownDto {
  @IsArray({ message: 'ids 必须是数组' })
  @ArrayMinSize(1, { message: '至少需要选择 1 个文件' })
  @IsUUID('4', { each: true, message: '每个 id 必须是合法的 UUID v4' })
  ids: string[];
}
