import {
  Controller,
  Post,
  Body,
  Req,
} from '@nestjs/common';
import { Request } from 'express';
import { IsArray, IsOptional } from 'class-validator';
import { TelemetryService, TelemetryEvent } from './telemetry.service';
import { getClientIp } from '../common/utils/client-ip';

class ReportDto {
  @IsArray()
  @IsOptional()
  events: TelemetryEvent[];
}

@Controller('telemetry')
export class TelemetryController {
  constructor(private readonly telemetryService: TelemetryService) {}

  /**
   * 上报遥测数据（前端错误、性能、环境信息）
   * POST /api/telemetry/report
   * 
   * 无需认证 — 登录前后均可上报，后端根据 IP 和 UA 追踪。
   * 若请求带有有效 JWT Cookie，则自动关联 userId。
   */
  @Post('report')
  async report(
    @Body() dto: ReportDto,
    @Req() req: Request,
  ) {
    const ip = getClientIp(req);
    const userAgent = req.headers['user-agent'] || '';
    // req.user 由 JwtAuthGuard 注入（若存在则自动解析，不存在则为 undefined）
    const userId = (req as any).user?.id || null;

    await this.telemetryService.report(
      dto.events || [],
      ip,
      userAgent,
      userId,
    );

    return { code: 0, message: 'ok', count: dto.events?.length || 0 };
  }
}
