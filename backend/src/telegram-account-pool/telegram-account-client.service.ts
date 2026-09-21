import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios, { AxiosError } from 'axios';
import FormData from 'form-data';
import { Readable } from 'stream';
import { AccountAttemptSample, AccountFailureKind } from './telegram-account-pool.types';

/**
 * 账号级 Telegram 调用错误：携带可供账号池决策的分类信息。
 *
 * 与 `TelegramService` 的既有错误类型并存而不替代：**原单账号链路完全不变**，
 * 本错误只在新池化路径中出现，便于上层做「换账号重试」。
 */
export class TelegramAccountError extends Error {
  constructor(
    message: string,
    readonly accountId: string,
    readonly kind: AccountFailureKind,
    readonly status?: number,
    readonly retryAfterSeconds?: number,
  ) {
    super(message);
    this.name = 'TelegramAccountError';
  }
}

/** 一次流式下载会话：`sample()` 在流结束后取样本，用于带宽/健康 EWMA */
export interface AccountStreamSession {
  stream: Readable;
  info: { file_id: string; file_size: number };
  /** 取得本次会话的采样（必须在流 end/close/error 之后调用） */
  sample: () => AccountAttemptSample;
}

/**
 * 按账号发起的 Telegram 调用（多账号路径专用）。
 *
 * 为什么不改造 `TelegramService`：它的 token 是构造期字段、并被 5 处下载链路与
 * 上下文深度耦合；直接改会造成大面积回归风险。这里以**新增**方式实现同样的
 * 端点语义（apiBase / fileBase / streamingBase 与它共用同一批环境变量），
 * 由调用方显式传入 accountId，从而让「按负载选号」成为可能。
 */
@Injectable()
export class TelegramAccountClientService {
  private readonly logger = new Logger(TelegramAccountClientService.name);
  private readonly apiBase: string;
  private readonly streamingBase: string;
  private readonly streamingEnabled: boolean;
  private readonly streamingTimeoutMs: number;

  constructor(private readonly configService: ConfigService) {
    const base = (this.configService.get<string>('TELEGRAM_API_BASE') || 'https://api.telegram.org').replace(/\/$/, '');
    this.apiBase = `${base}/bot`;
    const streamingConfig = (this.configService.get<string>('TELEGRAM_FILE_STREAM_BASE') || '').trim();
    const enabledFlag = (this.configService.get<string>('TELEGRAM_FILE_STREAMING_ENABLED') || '').trim().toLowerCase();
    this.streamingEnabled = enabledFlag === 'false'
      ? false
      : enabledFlag === 'true' || Boolean(streamingConfig);
    this.streamingBase = (streamingConfig || base).replace(/\/$/, '');
    const timeoutSeconds = Number(this.configService.get<string>('TELEGRAM_FILE_STREAM_TIMEOUT_SECONDS'));
    this.streamingTimeoutMs = Number.isFinite(timeoutSeconds) && timeoutSeconds > 0
      ? timeoutSeconds * 1000
      : 180_000;
  }

  /** 是否具备二次开发的流式端点（决定下载走 /stream/file 还是标准 /file 路径） */
  isStreamingEnabled(): boolean {
    return this.streamingEnabled;
  }

  /** 健康探测：getMe（成本极低，仅用于刷新健康/延迟） */
  async getMe(accountId: string, token: string): Promise<{ ok: boolean; latencyMs?: number; error?: string }> {
    const started = Date.now();
    try {
      const response = await axios.get(`${this.apiBase}${token}/getMe`, { timeout: 10_000 });
      if (response.data?.ok === true) {
        return { ok: true, latencyMs: Date.now() - started };
      }
      return { ok: false, error: 'getMe 返回 ok!=true' };
    } catch (error) {
      const message = this.describeError(error, token);
      // 账号标识用于排障定位（不含 token；describeError 已脱敏）
      this.logger.debug(`账号 ${accountId} getMe 失败：${message}`);
      return { ok: false, error: message };
    }
  }

  /** Webhook 状态（与 getUpdates 互斥，启动时用于冲突告警） */
  async getWebhookInfo(accountId: string, token: string): Promise<{ url?: string }> {
    try {
      const response = await axios.get(`${this.apiBase}${token}/getWebhookInfo`, { timeout: 10_000 });
      return { url: response.data?.result?.url || '' };
    } catch (error) {
      throw this.toAccountError(error, token, accountId);
    }
  }

  /** 长轮询 getUpdates（每账号独立 offset，由调用方维护） */
  async getUpdates(
    accountId: string,
    token: string,
    offset: number,
    timeoutSeconds: number,
  ): Promise<Array<Record<string, unknown>>> {
    try {
      const response = await axios.get(`${this.apiBase}${token}/getUpdates`, {
        params: { offset, timeout: timeoutSeconds, allowed_updates: ['message', 'channel_post'] },
        timeout: (timeoutSeconds + 15) * 1000,
      });
      if (response.data?.ok !== true) {
        throw new TelegramAccountError(
          'getUpdates 返回 ok!=true',
          accountId,
          'other',
        );
      }
      return Array.isArray(response.data.result) ? response.data.result : [];
    } catch (error) {
      throw this.toAccountError(error, token, accountId);
    }
  }

  /** 转发消息（用于「任意 bot 收到文件 → 转发到归档群」；注意 bot 间互不可见的约束） */
  async forwardMessage(
    accountId: string,
    token: string,
    toChatId: string,
    fromChatId: string,
    messageId: string,
  ): Promise<{ messageId: string }> {
    try {
      const response = await axios.post(`${this.apiBase}${token}/forwardMessage`, {
        chat_id: toChatId,
        from_chat_id: fromChatId,
        message_id: Number(messageId),
      }, { timeout: 30_000 });
      const newId = response.data?.result?.message_id;
      if (response.data?.ok !== true || !newId) {
        throw new TelegramAccountError('forwardMessage 返回缺少 message_id', accountId, 'other');
      }
      return { messageId: String(newId) };
    } catch (error) {
      throw this.toAccountError(error, token, accountId);
    }
  }

  /**
   * 发送文本消息（**由收到消息的账号回复该用户**）。
   *
   * 为什么必须按账号发送：Telegram 里「谁收到消息谁回复」是身份契约；用默认账号回复
   * 会让用户收到的链接/提示来自另一个 Bot，且与 `sourceAccountId` 记录不一致。
   * 这里不做「失败后改用默认账号」的兜底——那会造成跨账号身份错用。
   */
  async sendMessage(
    accountId: string,
    token: string,
    chatId: string,
    text: string,
    options?: { replyToMessageId?: number; disableNotification?: boolean },
  ): Promise<void> {
    try {
      const payload: Record<string, unknown> = {
        chat_id: String(chatId),
        text,
        disable_web_page_preview: false,
      };
      if (options?.replyToMessageId) payload.reply_to_message_id = options.replyToMessageId;
      if (options?.disableNotification) payload.disable_notification = true;
      const response = await axios.post(`${this.apiBase}${token}/sendMessage`, payload, { timeout: 20_000 });
      if (response.data?.ok !== true) {
        throw new TelegramAccountError('sendMessage 返回 ok!=true', accountId, 'other');
      }
    } catch (error) {
      throw this.toAccountError(error, token, accountId);
    }
  }

  /**
   * 查询 chat 元信息：用于启动期校验每个账号的存储 Chat 是否存在、是否可被该账号访问
   * （bot 未被加入群 / chatId 写错时，上传副本会整批失败）。
   */
  async getChat(
    accountId: string,
    token: string,
    chatId: string,
  ): Promise<{ id: string; type: string; title?: string }> {
    try {
      const response = await axios.get(`${this.apiBase}${token}/getChat`, {
        params: { chat_id: chatId },
        timeout: 10_000,
      });
      const result = response.data?.result;
      if (response.data?.ok !== true || !result) {
        throw new TelegramAccountError('getChat 返回 ok!=true', accountId, 'other');
      }
      return {
        id: String(result.id),
        type: String(result.type ?? ''),
        title: result.title ? String(result.title) : undefined,
      };
    } catch (error) {
      throw this.toAccountError(error, token, accountId);
    }
  }

  /**
   * 上传文档（用于「副本扩散」：把已有副本的字节用另一个账号各上传一份）。
   * 流式上传必须给 knownLength，且流只能消费一次（失败不自动重试）。
   */
  async sendDocumentStream(
    accountId: string,
    token: string,
    chatId: string,
    stream: Readable,
    filename: string,
    knownLength: number,
    opts?: { signal?: AbortSignal },
  ): Promise<{
    fileId: string;
    fileSize: number;
    chatId: string;
    messageId: string;
    sample: AccountAttemptSample;
  }> {
    const started = Date.now();
    const form = new FormData();
    try {
      form.append('chat_id', chatId);
      form.append('document', stream, { filename, knownLength });
      const response = await axios.post(`${this.apiBase}${token}/sendDocument`, form, {
        headers: { ...form.getHeaders() },
        timeout: 15 * 60 * 1000,
        maxBodyLength: Infinity,
        maxContentLength: Infinity,
        signal: opts?.signal,
      });
      const result = response.data?.result ?? {};
      const media = result.document || result.animation || result.video || result.audio || result.voice;
      const fileId = media?.file_id;
      if (!fileId) {
        throw new TelegramAccountError('sendDocument 响应缺少 file_id', accountId, 'other');
      }
      const durationMs = Date.now() - started;
      this.logger.log(
        `账号 ${accountId} 副本上传完成：${filename}（${knownLength} 字节 / ${(durationMs / 1000).toFixed(1)}s）`,
      );
      return {
        fileId: String(fileId),
        fileSize: Number(media.file_size ?? knownLength),
        chatId: String(result.chat?.id ?? chatId),
        messageId: String(result.message_id ?? ''),
        sample: { ok: true, bytes: knownLength, durationMs },
      };
    } catch (error) {
      const accountError = this.toAccountError(error, token, accountId);
      throw new TelegramAccountError(
        accountError.message,
        accountId,
        accountError.kind,
        accountError.status,
        accountError.retryAfterSeconds,
      );
    } finally {
      // 与既有上传一致：请求结束（成功/失败/取消）立即释放源流与 multipart 传输资源
      if (!stream.destroyed && !stream.readableEnded) {
        try {
          stream.destroy();
        } catch {
          // 忽略清理异常
        }
      }
      try {
        (form as unknown as { destroy?: () => void }).destroy?.();
      } catch {
        // 忽略清理异常
      }
    }
  }

  /**
   * 打开实时流（二次开发 fork 的 /stream/file 端点）。
   * 返回的 `sample()` 会给出本次传输的字节数与耗时，供账号池更新带宽 EWMA。
   */
  async openRealtimeStream(
    accountId: string,
    token: string,
    fileId: string,
    expectedSize?: number,
    opts?: { noCache?: boolean },
  ): Promise<AccountStreamSession> {
    if (!this.streamingEnabled) {
      throw new TelegramAccountError(
        '未启用流式端点（TELEGRAM_FILE_STREAM_BASE 未配置），账号池下载路径不可用',
        accountId,
        'unavailable',
      );
    }
    const headers: Record<string, string> = {};
    if (expectedSize !== undefined) headers['X-Telegram-File-Size'] = String(expectedSize);
    if (opts?.noCache) headers['X-Telegram-No-Cache'] = '1';

    const url = `${this.streamingBase}/stream/file/bot${token}/${encodeURIComponent(fileId)}`;
    const started = Date.now();
    let transferred = 0;
    let settled: AccountAttemptSample | null = null;

    try {
      const response = await axios.get<Readable>(url, {
        responseType: 'stream',
        timeout: this.streamingTimeoutMs,
        maxRedirects: 0,
        headers: Object.keys(headers).length > 0 ? headers : undefined,
      });
      const rawLength = response.headers['content-length'];
      const fileSize = Number(Array.isArray(rawLength) ? rawLength[0] : rawLength);
      const upstream = response.data as Readable;
      upstream.on('data', (chunk: Buffer) => {
        transferred += chunk.length;
      });
      upstream.on('end', () => {
        settled = { ok: true, bytes: transferred, durationMs: Date.now() - started };
      });
      upstream.on('error', (error: Error) => {
        settled = {
          ok: false,
          bytes: transferred,
          durationMs: Date.now() - started,
          failureKind: 'network',
          errorMessage: this.redact(error.message, token),
        };
      });
      return {
        stream: upstream,
        info: { file_id: fileId, file_size: Number.isSafeInteger(fileSize) && fileSize > 0 ? fileSize : 0 },
        sample: () => settled ?? {
          ok: false,
          bytes: transferred,
          durationMs: Date.now() - started,
          failureKind: 'timeout',
          errorMessage: '流未正常结束（可能被客户端中断或超时）',
        },
      };
    } catch (error) {
      throw this.toAccountError(error, token, accountId);
    }
  }

  // ---------------- 错误归类与脱敏 ----------------

  private toAccountError(error: unknown, token: string, accountId: string): TelegramAccountError {
    if (error instanceof TelegramAccountError) return error;
    const axiosError = error as AxiosError<{ description?: string; parameters?: { retry_after?: number } }>;
    const status = axiosError?.response?.status;
    const description = axiosError?.response?.data?.description || axiosError?.message || String(error);
    const retryAfter = axiosError?.response?.data?.parameters?.retry_after
      ?? this.parseRetryAfter(description);
    const kind = this.classify(status, description);
    return new TelegramAccountError(
      this.redact(description, token).slice(0, 500),
      accountId,
      kind,
      status,
      retryAfter,
    );
  }

  private parseRetryAfter(description: string): number | undefined {
    const match = /retry after (\d+)/i.exec(description) || /FLOOD_WAIT_(\d+)/i.exec(description);
    if (!match) return undefined;
    const value = Number(match[1]);
    return Number.isSafeInteger(value) && value > 0 ? value : undefined;
  }

  /** 失败分类 → 决定账号池冷却时长（限流类最长） */
  private classify(status: number | undefined, description: string): AccountFailureKind {
    const lower = description.toLowerCase();
    if (status === 429 || lower.includes('too many requests') || lower.includes('flood_wait')) {
      return 'flood';
    }
    if (
      lower.includes('exact file size is unavailable')
      || lower.includes('file size is unavailable')
      || lower.includes('file_id_invalid')
      || lower.includes('invalid file_id')
      || lower.includes('file not found')
      || status === 502
      || status === 400
    ) {
      return 'unavailable';
    }
    if (status === 504 || lower.includes('timeout') || lower.includes('etimedout') || lower.includes('econnaborted')) {
      return 'timeout';
    }
    if (lower.includes('econnreset') || lower.includes('socket hang up') || lower.includes('eai_again')) {
      return 'network';
    }
    return 'other';
  }

  private describeError(error: unknown, token: string): string {
    const axiosError = error as AxiosError;
    const description = axiosError?.response?.data
      ? JSON.stringify(axiosError.response.data).slice(0, 200)
      : (axiosError?.message || String(error));
    return this.redact(description, token);
  }

  /** 脱敏：移除 URL 形态与字面量形态的 token（与 TelegramService.redactToken 同策略） */
  private redact(text: string, token: string): string {
    let out = text.replace(/\/bot[^/]+\//g, '/bot[REDACTED]/');
    if (token) out = out.split(token).join('[REDACTED]');
    return out;
  }
}
