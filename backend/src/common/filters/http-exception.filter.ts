import {
  ExceptionFilter,
  Catch,
  ArgumentsHost,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { Response } from 'express';

/**
 * 全局异常过滤器。
 *
 * 统一错误响应结构，使其与 TransformInterceptor 的成功结构 { code, message, data }
 * 保持一致：错误时返回 { code, message, data: null }。
 * - code: HTTP 状态码（业务错误沿用对应状态码）
 * - message: 人类可读错误信息（校验错误为消息数组）
 * - data: 恒为 null
 *
 * 生产环境不回显未知错误的堆栈/内部细节，避免信息泄露。
 */
@Catch()
export class GlobalExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(GlobalExceptionFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const res = ctx.getResponse<Response>();

    // 已发送响应头（如文件下载流中途出错）则不再写入
    if (res.headersSent) {
      return;
    }

    let status = HttpStatus.INTERNAL_SERVER_ERROR;
    let message: string | string[] = '服务器内部错误';

    if (exception instanceof HttpException) {
      status = exception.getStatus();
      const exceptionResponse = exception.getResponse();
      if (typeof exceptionResponse === 'string') {
        message = exceptionResponse;
      } else if (typeof exceptionResponse === 'object' && exceptionResponse !== null) {
        const resp = exceptionResponse as { message?: string | string[] };
        message = resp.message ?? exception.message;
      }
    } else if (exception instanceof Error) {
      // 非 HTTP 异常：记录完整错误到服务端日志，但对外仅返回通用消息
      this.logger.error(`未捕获异常: ${exception.message}`, exception.stack);
      message = '服务器内部错误';
    }

    res.status(status).json({
      code: status,
      message,
      data: null,
    });
  }
}
