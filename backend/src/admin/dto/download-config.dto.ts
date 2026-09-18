import { IsInt, IsNumber, IsOptional, Max, Min } from 'class-validator';
import { Type } from 'class-transformer';

/**
 * 下载资源调度配置（FILE_DOWNLOAD_*）。
 * 全部可选：只提交需要变更的字段，热更新只影响后续任务的准入判断。
 */
export class DownloadConfigDto {
  /** 全部在途任务未写入预约总上限（GB，0 = 仅受物理空间约束） */
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  @Max(10000)
  maxReservedGB?: number;

  /** 上游冷回源并发上限 */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(64)
  maxConcurrentUpstreams?: number;

  /** 等待队列容量（磁盘与上游共用） */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(10000)
  queueCapacity?: number;

  /** 排队等待上限（秒） */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(5)
  @Max(86400)
  queueTimeoutSeconds?: number;

  /** spool 最后一个消费者离开后的复用宽限期（秒） */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(3600)
  spoolGraceSeconds?: number;

  /** 有界滚动缓冲直通的窗口大小（MB）：值越小内存占用越低、吞吐越依赖上游速度 */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(1024)
  directWindowMB?: number;

  /** 直接下载端点（非任务化）允许的有限等待上限（秒），0 表示不等待 */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(600)
  directWaitSeconds?: number;

  /** 下载任务状态保留时间（秒） */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(60)
  @Max(86400)
  taskRetentionSeconds?: number;
}
