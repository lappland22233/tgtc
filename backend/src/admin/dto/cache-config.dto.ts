import { IsOptional, IsNumber, Min, Max, IsBoolean } from 'class-validator';
import { Type, Transform } from 'class-transformer';

export class CacheConfigDto {
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(1)
  @Max(1000)
  maxSizeGB?: number;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0.5)
  @Max(100)
  minFreeDiskGB?: number;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(1)
  @Max(365)
  ttlDays?: number;

  @IsOptional()
  @Transform(({ value }) => value === true || value === 'true')
  @IsBoolean()
  noCacheMode?: boolean;
}
