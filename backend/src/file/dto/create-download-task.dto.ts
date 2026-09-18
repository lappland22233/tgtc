import { IsBoolean, IsOptional } from 'class-validator';
import { Transform } from 'class-transformer';

/** 创建下载任务的请求参数（两阶段下载的第一阶段） */
export class CreateDownloadTaskDto {
  /**
   * 请求级无缓存：本次下载不发布正式缓存（管理员排障用）。
   * 缺省时沿用全局缓存策略。
   */
  @IsOptional()
  @Transform(({ value }) => value === true || value === 'true')
  @IsBoolean()
  nocache?: boolean;
}
