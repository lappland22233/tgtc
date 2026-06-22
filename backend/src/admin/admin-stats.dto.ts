import {
  IsString,
  IsOptional,
  IsInt,
  Min,
  Max,
  IsDateString,
  IsIn,
} from 'class-validator';
import { Type } from 'class-transformer';

export class DateRangeQueryDto {
  @IsOptional()
  @IsString()
  @IsIn(['1h', '24h', '7d', '30d'])
  timeRange?: string;

  @IsOptional()
  @IsDateString()
  startDate?: string;

  @IsOptional()
  @IsDateString()
  endDate?: string;
}

export class TopFilesQueryDto {
  @IsOptional()
  @IsString()
  @IsIn(['1h', '24h', '7d', '30d'])
  timeRange?: string;

  @IsOptional()
  @IsDateString()
  startDate?: string;

  @IsOptional()
  @IsDateString()
  endDate?: string;

  @IsOptional()
  @IsString()
  action?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number = 10;

  @IsOptional()
  @IsString()
  @IsIn(['accessCount', 'bandwidth'])
  sortBy?: string;
}

export class TopPathsQueryDto {
  @IsOptional()
  @IsString()
  @IsIn(['1h', '24h', '7d', '30d'])
  timeRange?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number = 20;

  @IsOptional()
  @IsString()
  excludePaths?: string;
}

export class StatusByPathQueryDto {
  @IsOptional()
  @IsString()
  @IsIn(['1h', '24h', '7d', '30d'])
  timeRange?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(100)
  @Max(599)
  statusCode?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  limit?: number = 50;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  minCount?: number = 5;

  @IsOptional()
  @IsString()
  @IsIn(['pivot', 'grouped'])
  format?: string;
}

export class AbnormalIpsQueryDto {
  @IsOptional()
  @IsString()
  @IsIn(['1h', '24h', '7d', '30d'])
  timeRange?: string;

  @IsOptional()
  @IsString()
  @IsIn(['requestCount', 'errorRate', 'bandwidth'])
  sortBy?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  limit?: number = 20;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  minRequests?: number = 100;
}

export class RefererAnalysisQueryDto {
  @IsOptional()
  @IsString()
  @IsIn(['24h', '7d', '30d'])
  timeRange?: string = '7d';
}

export class UserAgentAnalysisQueryDto {
  @IsOptional()
  @IsString()
  @IsIn(['24h', '7d', '30d'])
  timeRange?: string = '7d';

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(10)
  @Max(1000)
  topN?: number = 500;
}

export class BandwidthQueryDto {
  @IsOptional()
  @IsString()
  @IsIn(['24h', '7d', '30d'])
  timeRange?: string = '24h';
}

export class FileTypeQueryDto {
  @IsOptional()
  @IsString()
  @IsIn(['24h', '7d', '30d'])
  timeRange?: string = '24h';
}
