import {
  Controller,
  Post,
  Body,
  Req,
  HttpException,
  HttpStatus,
} from '@nestjs/common';
import { Request } from 'express';
import {
  IsArray,
  IsNumber,
  IsObject,
  IsOptional,
  IsString,
  IsNotEmpty,
  ArrayMaxSize,
  MaxLength,
  ValidateNested,
  registerDecorator,
  ValidationArguments,
  ValidatorConstraint,
  ValidatorConstraintInterface,
} from 'class-validator';
import { Type } from 'class-transformer';
import { JwtService } from '@nestjs/jwt';
import { TelemetryService } from './telemetry.service';
import { getClientIp } from '../common/utils/client-ip';
import { RateLimitService } from '../common/services/rate-limit.service';

/** 单次上报允许的最大事件数（防止单次提交百万事件导致 OOM） */
export const TELEMETRY_MAX_EVENTS_PER_REPORT = 50;
/** 单个事件 data 载荷的最大字节数（防止超大 JSON 撑爆存储） */
export const TELEMETRY_MAX_DATA_BYTES = 8 * 1024;

/** IP 级速率限制：窗口内最多上报次数 / 窗口时长 / 触发后锁定时长 */
const TELEMETRY_RATE_MAX_ATTEMPTS = 60;
const TELEMETRY_RATE_WINDOW_MS = 60 * 1000;
const TELEMETRY_RATE_LOCK_MS = 5 * 60 * 1000;

/** 校验 JSON 序列化后的字节大小上限 */
@ValidatorConstraint({ name: 'maxJsonBytes' })
class MaxJsonBytesConstraint implements ValidatorConstraintInterface {
  validate(value: unknown, args: ValidationArguments): boolean {
    if (value === undefined || value === null) return true;
    try {
      return Buffer.byteLength(JSON.stringify(value), 'utf8') <= (args.constraints[0] as number);
    } catch {
      // 无法序列化（如循环引用）视为非法
      return false;
    }
  }

  defaultMessage(args: ValidationArguments): string {
    return `数据载荷超过大小上限 (${args.constraints[0]} bytes)`;
  }
}

function MaxJsonBytes(bytes: number) {
  return (object: object, propertyName: string) =>
    registerDecorator({
      name: 'maxJsonBytes',
      target: object.constructor,
      propertyName,
      constraints: [bytes],
      validator: MaxJsonBytesConstraint,
    });
}

class TelemetryEventDto {
  // 不限制为枚举：前端还会上报 network/click_context 等扩展类型，
  // 仅约束为非空字符串且长度匹配 varchar(20) 列，避免整批 400 中断上报
  @IsString()
  @IsNotEmpty()
  @MaxLength(32)
  type: string;

  @IsOptional()
  @IsObject()
  @MaxJsonBytes(TELEMETRY_MAX_DATA_BYTES)
  data: Record<string, any>;

  // 客户端时间戳可能为小数（performance.timing.navigationStart），用 IsNumber 而非 IsInt
  @IsOptional()
  @IsNumber()
  clientTimestamp?: number;
}

class ReportDto {
  @IsArray()
  @IsOptional()
  @ArrayMaxSize(TELEMETRY_MAX_EVENTS_PER_REPORT)
  @ValidateNested({ each: true })
  @Type(() => TelemetryEventDto)
  events: TelemetryEventDto[];
}

@Controller('telemetry')
export class TelemetryController {
  constructor(
    private readonly telemetryService: TelemetryService,
    private readonly rateLimitService: RateLimitService,
    private readonly jwtService: JwtService,
  ) {}

  /**
   * 上报遥测数据（前端错误、性能、环境信息）
   * POST /api/telemetry/report
   *
   * 无需认证 — 登录前后均可上报，后端根据 IP 和 UA 追踪。
   * 若请求带有有效 JWT Cookie，则自动关联 userId。
   *
   * 防护：events 数组上限 50 条（DTO 校验）+ IP 级速率限制，
   * 防止攻击者单次提交海量事件或高频写入撑爆数据库。
   */
  @Post('report')
  async report(
    @Body() dto: ReportDto,
    @Req() req: Request,
  ) {
    const ip = getClientIp(req);

    // IP 级速率限制，防止高频上报写放大 DoS
    const limit = await this.rateLimitService.checkAndIncrement(
      `telemetry:report:${ip}`,
      'telemetry_report',
      TELEMETRY_RATE_MAX_ATTEMPTS,
      TELEMETRY_RATE_LOCK_MS,
      TELEMETRY_RATE_WINDOW_MS,
    );
    if (!limit.allowed) {
      throw new HttpException(
        `遥测上报过于频繁，请 ${limit.waitMinutes ?? 5} 分钟后重试`,
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    const userAgent = req.headers['user-agent'] || '';
    const userId = this.extractOptionalUserId(req);

    const events = dto.events || [];
    // 性能统计会在管理端转为浮点数；写入前拒绝非有限数值，防止持久化数据投毒。
    const performanceFields = ['dns', 'tcp', 'ttfb', 'domReady', 'pageLoad', 'fcp'];
    for (const event of events) {
      if (event.type !== 'performance') continue;
      for (const field of performanceFields) {
        const value = event.data?.[field];
        if (value !== undefined && (typeof value !== 'number' || !Number.isFinite(value) || value < 0)) {
          throw new HttpException(`性能遥测字段 ${field} 必须为非负有限数值`, HttpStatus.BAD_REQUEST);
        }
      }
    }
    await this.telemetryService.report(
      events,
      ip,
      userAgent,
      userId,
    );

    return { code: 0, message: 'ok', count: events.length };
  }

  /**
   * 遥测接口允许匿名访问，因此不能使用强制认证 Guard。
   * 仅在 Cookie/Bearer 中存在且签名、有效期均合法时提取 sub；无效令牌按匿名处理。
   */
  private extractOptionalUserId(req: Request): string | undefined {
    const cookieToken = req.cookies?.access_token;
    const authorization = req.headers.authorization;
    const bearerToken = typeof authorization === 'string' && authorization.startsWith('Bearer ')
      ? authorization.slice(7)
      : undefined;
    const token = typeof cookieToken === 'string' ? cookieToken : bearerToken;
    if (!token || token.split('.').length !== 3) return undefined;

    try {
      const payload = this.jwtService.verify<{ sub?: string }>(token, { algorithms: ['HS256'] });
      return typeof payload?.sub === 'string' ? payload.sub : undefined;
    } catch {
      return undefined;
    }
  }
}
