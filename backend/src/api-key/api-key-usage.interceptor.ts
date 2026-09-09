import { CallHandler, ExecutionContext, HttpException, Injectable, NestInterceptor } from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { Observable, throwError } from 'rxjs';
import { catchError, finalize } from 'rxjs/operators';
import { getApiKeyContext } from '../common/auth-context';
import { getClientIp } from '../common/utils/client-ip';
import { ApiKeyUsageResult } from '../common/entities/api-key-usage-log.entity';
import { ApiKeyUsageService } from './api-key-usage.service';

/**
 * API 密钥使用审计拦截器（v1.2.6）。
 *
 * 为什么不用 AccessLogMiddleware：中间件在 Nest Guard 之前执行，此时
 * request.user 尚未由 JwtOrApiKeyAuthGuard 写入，无法可靠归因 API Key 身份。
 * 拦截器在 Guard 之后运行，可以拿到已认证的 API Key 上下文。
 *
 * 仅记录经 API Key 认证的请求（JWT 请求直接跳过）；白名单拒绝发生在
 * Guard 内，请求不会到达拦截器，由认证链路直接写入 denied_ip 记录。
 * 写入为 fire-and-forget，失败不影响业务响应。
 */
@Injectable()
export class ApiKeyUsageInterceptor implements NestInterceptor {
  constructor(private readonly usageService: ApiKeyUsageService) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const http = context.switchToHttp();
    const request = http.getRequest();
    const response = http.getResponse();

    const keyContext = getApiKeyContext(request?.user);
    if (!keyContext) {
      return next.handle();
    }

    const method = typeof request?.method === 'string' ? request.method : '';
    const rawUrl = typeof request?.originalUrl === 'string' ? request.originalUrl : (request?.url || '');
    const route = rawUrl.split('?')[0] || '';
    const ip = getClientIp(request) || '';

    // S2：业务异常（404/409/429 等）由全局异常过滤器在拦截器 finalize 之后处理，
    // finalize 读到的 response.statusCode 仍是 200——审计会失真。
    // 在 catchError 中先行记录真实状态码并用 recorded 标志防止 finalize 双写。
    let recorded = false;
    const recordOnce = (statusCode: number) => {
      if (recorded) return;
      recorded = true;
      this.usageService.record({
        apiKeyId: keyContext.keyId,
        userId: request.user?.id ?? '',
        method,
        route,
        result: ApiKeyUsageResult.ALLOWED,
        statusCode,
        ip,
      });
    };

    return next.handle().pipe(
      catchError((error: unknown) => {
        recordOnce(error instanceof HttpException ? error.getStatus() : 500);
        return throwError(() => error);
      }),
      finalize(() => {
        recordOnce(typeof response?.statusCode === 'number' ? response.statusCode : 200);
      }),
    );
  }
}

/** 全局注册提供者（挂在 ApiKeyModule 中） */
export const API_KEY_USAGE_INTERCEPTOR = {
  provide: APP_INTERCEPTOR,
  useClass: ApiKeyUsageInterceptor,
};
