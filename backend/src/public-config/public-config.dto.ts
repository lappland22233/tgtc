import { IsString, MaxLength } from 'class-validator';

/**
 * 匿名公开配置接口的固定输出白名单。
 * 不复用通用系统配置实体，避免新增配置键被意外暴露。
 */
export class PublicConfigDto {
  @IsString()
  @MaxLength(200)
  siteTitle: string;

  @IsString()
  @MaxLength(100)
  version: string;
}
