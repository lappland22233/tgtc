import {
  ExceptionFilter,
  Catch,
  ArgumentsHost,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { Request, Response } from 'express';
import { randomUUID } from 'crypto';
import { sanitizeUrlForLog } from '../utils/sensitive-data';

/**
 * 全局异常过滤器。
 *
 * 统一错误响应结构，使其与 TransformInterceptor 的成功结构 { code, message, data }
 * 保持一致：错误时返回 { code, message, data: null }。
 * - code: HTTP 状态码（业务错误沿用对应状态码）
 * - message: 人类可读错误信息（校验错误为消息数组）
 * - data: 恒为 null
 * - requestId: 每次请求的关联 ID（非 HTTP 异常时生成，供运维定位服务端日志）
 *
 * 生产环境不回显未知错误的堆栈/内部细节，避免信息泄露；
 * 服务端日志中的 URL 经过脱敏，杜绝访问凭据进入日志（C-02 修复）。
 */
@Catch()
export class GlobalExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(GlobalExceptionFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const res = ctx.getResponse<Response>();
    const req = ctx.getRequest<Request>();

    // 已发送响应头（如文件下载流中途出错）则不再写入
    if (res.headersSent) {
      return;
    }

    let status = HttpStatus.INTERNAL_SERVER_ERROR;
    let message: string | string[] = '服务器内部错误';
    let requestId: string | undefined;

    if (exception instanceof HttpException) {
      status = exception.getStatus();
      const exceptionResponse = exception.getResponse();
      if (typeof exceptionResponse === 'string') {
        message = exceptionResponse;
      } else if (typeof exceptionResponse === 'object' && exceptionResponse !== null) {
        const resp = exceptionResponse as { message?: string | string[] };
        message = resp.message ?? exception.message;
      }
      // 5xx（含显式抛出的 InternalServerErrorException）也应记录服务端日志并回传
      // requestId，避免内部错误被 HttpException 包装后掩盖堆栈。
      if (status >= HttpStatus.INTERNAL_SERVER_ERROR) {
        requestId = randomUUID();
        const safeUrl = sanitizeUrlForLog((req.originalUrl || req.url || '/').split('#')[0]);
        this.logger.error(
          `HTTP ${status} [requestId=${requestId}] ${req.method} ${safeUrl}: ${exception.message}`,
          exception.stack,
        );
        res.setHeader('X-Request-Id', requestId);
      }
    } else if (exception instanceof Error) {
      // 非 HTTP 异常：记录完整错误到服务端日志（URL 脱敏），对外仅返回通用消息
      requestId = randomUUID();
      const safeUrl = sanitizeUrlForLog((req.originalUrl || req.url || '/').split('#')[0]);
      this.logger.error(
        `未捕获异常 [requestId=${requestId}] ${req.method} ${safeUrl}: ${exception.message}`,
        exception.stack,
      );
      message = '服务器内部错误';
      res.setHeader('X-Request-Id', requestId);
    }

    res.status(status).json({
      code: status,
      message,
      data: null,
    });
  }
}
