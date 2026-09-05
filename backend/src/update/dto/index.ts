import { Type } from 'class-transformer';
import { IsInt, IsOptional, Max, Min } from 'class-validator';

export class InstallUpdateDto {
  /** 后端检查得到的候选 releaseId；安装时后端会重新核验，防止候选被替换 */
  @Type(() => Number)
  @IsInt()
  @Min(1)
  releaseId!: number;
}

export class UpdateTasksQueryDto {
  @Type(() => Number)
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(50)
  limit?: number = 10;
}
