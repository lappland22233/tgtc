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

    // 已发送响应头（如文件下载流中途出错）则无法再写入 JSON 错误体。
    // 直接 return 会让连接悬挂（响应永不结束），此处强制结束连接：
    // - 对"正常已开始但中途出错"的流式响应，destroy() 会向客户端发送 TCP RST/中止；
    // - 若连接仍可写则 end() 优雅收尾。
    // 两者都能避免连接悬挂（G9-08）。同时记录服务端日志便于排障。
    if (res.headersSent) {
      const safeUrl = sanitizeUrlForLog((req.originalUrl || req.url || '/').split('#')[0]);
      const msg = exception instanceof Error ? exception.message : String(exception);
      this.logger.error(`响应已发送后出错 [${req.method}] ${safeUrl}: ${msg}`);
      try {
        if (res.writableEnded || res.destroyed) {
          return;
        }
        res.end();
      } catch {
        res.destroy();
      }
      return;
    }

    let status = HttpStatus.INTERNAL_SERVER_ERROR;
    let message: string | string[] = '服务器内部错误';
    let requestId: string | undefined;
    // 结构化业务错误（我方显式构造的 errorCode）：保留给前端队列/自动重试使用
    let structuredErrorCode: string | undefined;
    let structuredRetryAfterMs: number | undefined;

    if (exception instanceof HttpException) {
      status = exception.getStatus();
      // 4xx 客户端错误可回显业务可读信息；5xx 一律对外返回通用文案 + requestId，
      // 原始 message 仅写入服务端日志，避免内部细节（文件路径、SQL、依赖错误等）泄漏给客户端。
      if (status < HttpStatus.INTERNAL_SERVER_ERROR) {
        const exceptionResponse = exception.getResponse();
        if (typeof exceptionResponse === 'string') {
          message = exceptionResponse;
        } else if (typeof exceptionResponse === 'object' && exceptionResponse !== null) {
          const resp = exceptionResponse as {
            message?: string | string[];
            code?: unknown;
            errorCode?: unknown;
            retryAfterMs?: unknown;
          };
          message = resp.message ?? exception.message;
          structuredErrorCode = pickErrorCode(resp);
          if (structuredErrorCode) {
            applyStructuredErrorHeaders(res, structuredErrorCode, resp.retryAfterMs);
            structuredRetryAfterMs = retryAfterMsOf(resp.retryAfterMs);
          }
        }
      }
      // 5xx（含显式抛出的 InternalServerErrorException）也应记录服务端日志并回传
      // requestId，避免内部错误被 HttpException 包装后掩盖堆栈；对外仅返回通用文案。
      if (status >= HttpStatus.INTERNAL_SERVER_ERROR) {
        requestId = randomUUID();
        const safeUrl = sanitizeUrlForLog((req.originalUrl || req.url || '/').split('#')[0]);
        this.logger.error(
          `HTTP ${status} [requestId=${requestId}] ${req.method} ${safeUrl}: ${exception.message}`,
          exception.stack,
        );
        // 结构化业务错误（上传磁盘预算、下载资源协调器）的文案由本仓库显式提供且不含内部细节，
        // 保留它前端才能展示"服务器繁忙/排队等待"等可行动提示；其余 5xx 仍回退通用文案。
        const structuredResponse = exception.getResponse();
        if (typeof structuredResponse === 'object' && structuredResponse !== null) {
          const resp = structuredResponse as { code?: unknown; errorCode?: unknown; retryAfterMs?: unknown };
          structuredErrorCode = structuredErrorCode ?? pickErrorCode(resp);
          if (structuredErrorCode) {
            applyStructuredErrorHeaders(res, structuredErrorCode, resp.retryAfterMs);
            structuredRetryAfterMs = structuredRetryAfterMs ?? retryAfterMsOf(resp.retryAfterMs);
            const structuredMessage = (structuredResponse as { message?: string | string[] }).message;
            message = structuredMessage ?? message;
          }
        }
        if (!structuredErrorCode) message = '服务器内部错误';
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
    } else {
      // throw 了非 Error 值（如 throw 'xxx' / throw 42 / throw {…}）：
      // 无法读取 .message/.stack，统一记录 String(exception) + requestId，
      // 保证这类异常也有日志与 requestId 可追踪（G9-09）。
      requestId = randomUUID();
      const safeUrl = sanitizeUrlForLog((req.originalUrl || req.url || '/').split('#')[0]);
      let desc: string;
      try {
        desc = typeof exception === 'string' ? exception : JSON.stringify(exception);
      } catch {
        desc = String(exception);
      }
      this.logger.error(
        `未捕获非 Error 异常 [requestId=${requestId}] ${req.method} ${safeUrl}: ${desc}`,
      );
      message = '服务器内部错误';
      res.setHeader('X-Request-Id', requestId);
    }

    res.status(status).json({
      code: status,
      message,
      data: null,
      ...(structuredErrorCode ? { errorCode: structuredErrorCode } : {}),
      ...(structuredRetryAfterMs !== undefined ? { retryAfterMs: structuredRetryAfterMs } : {}),
    });
  }
}

/** 提取结构化业务码：优先 `errorCode`，兼容历史 `code: 'UPLOAD_DISK_BUDGET_BUSY'` 写法 */
function pickErrorCode(resp: { code?: unknown; errorCode?: unknown }): string | undefined {
  if (typeof resp.errorCode === 'string' && resp.errorCode) return resp.errorCode;
  if (typeof resp.code === 'string' && resp.code) return resp.code;
  return undefined;
}

/** 合法（>=1s）的建议重试间隔（毫秒） */
function retryAfterMsOf(value: unknown): number | undefined {
  const retryAfterMs = Number(value);
  return Number.isSafeInteger(retryAfterMs) && retryAfterMs >= 1000 ? retryAfterMs : undefined;
}

/** 写入 X-Tgtc-Error-Code 与 Retry-After，供前端排队提示与客户端自动退避 */
function applyStructuredErrorHeaders(res: Response, errorCode: string, retryAfterRaw: unknown): void {
  res.setHeader('X-Tgtc-Error-Code', errorCode);
  const retryAfterMs = retryAfterMsOf(retryAfterRaw);
  if (retryAfterMs !== undefined) {
    res.setHeader('Retry-After', String(Math.max(1, Math.ceil(retryAfterMs / 1000))));
  }
}
