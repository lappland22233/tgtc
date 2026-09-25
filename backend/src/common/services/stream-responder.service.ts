/**
 * 流式响应统一处理器。
 *
 * 职责：
 * - 设置响应头（nosniff / no-referrer / CSP / no-store 等安全头由调用方组合）。
 * - pipeline 传输、客户端中断处理。
 * - 响应结束后回填实际传输字节数到访问日志（socket.bytesWritten 差值）。
 * - headersSent 分支：头部未发送时返回统一 JSON 错误；已发送则中断连接。
 * - 错误响应统一为与全局异常过滤器一致的 { code: status, message, data: null }，
 *   5xx 附带 X-Request-Id 并记录服务端日志（URL 脱敏）。
 * - 416（Range Not Satisfiable）自动补充 Content-Range: bytes star/total。
 */
import { Injectable, Logger } from '@nestjs/common';
import { Request, Response } from 'express';
import { Readable } from 'stream';
import { pipeline } from 'stream';
import { promisify } from 'util';
import { randomUUID } from 'crypto';
import { sanitizeUrlForLog } from '../utils/sensitive-data';
import { buildContentRange } from '../utils/byte-range';

export interface StreamSendOptions {
  res: Response;
  stream: Readable;
  /** 额外响应头（Content-Type/Content-Disposition/Cache-Control 等） */
  headers?: Record<string, string>;
  /** 206 等非默认状态码 */
  status?: number;
  /** Range 命中时的 206 元数据（用于生成 Content-Range 头） */
  range?: { start: number; end: number; total: number };
  /** 访问日志 ID：完成后回填实际传输字节数 */
  accessLogId?: string | null;
  /** 访问日志字节回填函数（由调用方绑定 fileService 方法） */
  updateAccessLog?: (id: string, bytes: number) => Promise<void>;
}

@Injectable()
export class StreamResponderService {
  private readonly logger = new Logger(StreamResponderService.name);

  /**
   * 记录 pipeline 前的已发送字节数，返回用于完成后回填日志的闭包。
   *
   * 必须在进入时冻结 socket 引用：响应结束后 Node 会把 `res.socket` 置为 null，
   * 等到 pipeline 之后（finally）再读会恒为 0，使回填的字节数退化为 0 或负值。
   */
  private trackBytesSent(res: Response): () => number {
    const socket = res.socket ?? null;
    const startBytes = socket?.bytesWritten ?? 0;
    return () => (socket?.bytesWritten ?? 0) - startBytes;
  }

  /**
   * 流式传输：设置响应头 → pipeline → 回填实际传输字节数。
   * pipeline 内部处理客户端中断（stream 会收到 close，调用方无需手动 destroy）。
   */
  async send(options: StreamSendOptions): Promise<void> {
    const { res, stream, headers, status, range, accessLogId, updateAccessLog } = options;
    if (status) res.status(status);
    if (headers) res.set(headers);
    if (range) res.set('Content-Range', buildContentRange(range.start, range.end, range.total));

    const getBytesSent = this.trackBytesSent(res);
    const pipe = promisify(pipeline);
    try {
      await pipe(stream, res);
    } finally {
      if (accessLogId && updateAccessLog) {
        try {
          await updateAccessLog(accessLogId, getBytesSent());
        } catch {
          // 日志回填失败不影响响应本身
        }
      }
    }
  }

  /**
   * 流式请求的错误处理（统一响应格式）。
   * - 头部未发送：返回 `{ code: status, message, data: null }`，与全局异常过滤器一致；
   *   416 额外补充 Content-Range 通配头。
   * - 头部已发送：无法再改状态码，中断连接让客户端感知截断。
   * - 5xx：生成 requestId 记录服务端日志（URL 脱敏），并回传 X-Request-Id。
   */
  handleError(res: Response, error: unknown, fallbackMessage: string, req?: Request, requestId?: string): void {
    const status = (error as { status?: number }).status || 500;
    const isServerError = status >= 500;
    // 服务端日志用原始错误信息（不脱敏内部细节，仅供排查）
    const detailMessage = error instanceof Error ? error.message : fallbackMessage;
    // 结构化业务错误（下载资源协调器/上传磁盘预算）：文案由本仓库显式提供且不含内部细节，
    // 保留它前端才能展示"服务器繁忙 / 排队等待"等可行动提示，并写 Retry-After 便于自动退避。
    const structured = extractStructuredStreamError(error);
    // 客户端可见文案（G4-12）：5xx 一律使用调用方提供的安全通用文案 + requestId，
    // 不向客户端回显内部错误 message；仅 <500 的业务异常（白名单 HttpException 等）与结构化业务码透传。
    const clientMessage = isServerError ? (structured?.message ?? fallbackMessage) : detailMessage;

    if (!res.headersSent) {
      // 416：补充 Content-Range 通配头（RFC 7233）
      if (status === 416 && typeof (error as { total?: unknown }).total === 'number') {
        res.set('Content-Range', `bytes */${(error as { total: number }).total}`);
      }
      if (structured) {
        res.setHeader('X-Tgtc-Error-Code', structured.errorCode);
        if (structured.retryAfterMs !== undefined) {
          res.setHeader('Retry-After', String(Math.max(1, Math.ceil(structured.retryAfterMs / 1000))));
        }
      }
      const payload: Record<string, unknown> = {
        code: status,
        message: clientMessage,
        data: null,
        ...(structured ? { errorCode: structured.errorCode } : {}),
        ...(structured?.retryAfterMs !== undefined ? { retryAfterMs: structured.retryAfterMs } : {}),
      };
      if (isServerError) {
        const resolvedRequestId = requestId || randomUUID();
        const safeUrl = sanitizeUrlForLog((req?.originalUrl || req?.url || '/').split('#')[0]);
        this.logger.error(
          `HTTP ${status} [requestId=${resolvedRequestId}] ${req?.method ?? ''} ${safeUrl}: ${detailMessage}`,
          error instanceof Error ? error.stack : undefined,
        );
        res.setHeader('X-Request-Id', resolvedRequestId);
        payload.requestId = resolvedRequestId;
      }
      res.status(status).json(payload);
    } else if (!res.destroyed) {
      res.destroy(error instanceof Error ? error : new Error(clientMessage));
    }
  }
}

interface StructuredStreamError {
  errorCode: string;
  retryAfterMs?: number;
  message?: string;
}

/**
 * 从异常对象或 HttpException 响应体中提取结构化业务码。
 * 兼容 `errorCode`（下载资源协调器）与历史 `code`（上传磁盘预算）两种写法。
 */
function extractStructuredStreamError(error: unknown): StructuredStreamError | null {
  const candidate = error as {
    errorCode?: unknown;
    retryAfterMs?: unknown;
    getResponse?: () => unknown;
  } | null;

  let errorCode = typeof candidate?.errorCode === 'string' && candidate.errorCode
    ? candidate.errorCode
    : undefined;
  let retryAfterMs = normalizeRetryAfter(candidate?.retryAfterMs);
  let message: string | undefined;

  if (typeof candidate?.getResponse === 'function') {
    const body = candidate.getResponse();
    if (body && typeof body === 'object') {
      const resp = body as { errorCode?: unknown; code?: unknown; retryAfterMs?: unknown; message?: unknown };
      if (!errorCode) {
        errorCode = typeof resp.errorCode === 'string' && resp.errorCode
          ? resp.errorCode
          : (typeof resp.code === 'string' && resp.code ? resp.code : undefined);
      }
      retryAfterMs = retryAfterMs ?? normalizeRetryAfter(resp.retryAfterMs);
      if (typeof resp.message === 'string') message = resp.message;
    }
  }

  if (!errorCode) return null;
  return {
    errorCode,
    ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
    ...(message ? { message } : {}),
  };
}

/** 合法（>=1s）的建议重试间隔（毫秒） */
function normalizeRetryAfter(value: unknown): number | undefined {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 1000 ? parsed : undefined;
}
