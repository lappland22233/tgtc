import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios from 'axios';
import { Readable } from 'stream';
import { promises as fs } from 'fs';
import * as path from 'path';
import FormData from 'form-data';

@Injectable()
export class TelegramService {
  private readonly logger = new Logger(TelegramService.name);
  private readonly botToken: string;
  private readonly chatId: string;
  private readonly apiBase: string;
  private readonly fileBase: string;
  private readonly firstByteTimeoutMs: number;
  private readonly downloadRequestTimeoutMs: number;
  /**
   * 本地 Bot API 文件存储的允许根目录（白名单）。
   * 自建 telegram-bot-api 时 getFile 可能返回本地绝对路径，
   * 仅允许读取此目录内的文件；未配置时本地读取将被拒绝（fail-closed）。
   */
  private readonly localFileBase: string;

  constructor(private configService: ConfigService) {
    // 注意：botToken 在构造函数中一次性读取，不支持热更新
    // 如需更换 Token 需重启服务
    this.botToken = this.configService.get<string>('TELEGRAM_BOT_TOKEN') || '';
    this.chatId = this.configService.get<string>('TELEGRAM_CHAT_ID') || '';
    // 支持自建 API 代理绕过官方限流: 设置 TELEGRAM_API_BASE 即可
    // 默认 https://api.telegram.org，自建代理如 http://localhost:8081
    const base = this.configService.get<string>('TELEGRAM_API_BASE') || 'https://api.telegram.org';
    this.apiBase = `${base.replace(/\/$/, '')}/bot`;
    this.fileBase = `${base.replace(/\/$/, '')}/file/bot`;
    this.firstByteTimeoutMs = this.getPositiveNumberConfig('TELEGRAM_FIRST_BYTE_TIMEOUT_MS', 15 * 1000);
    this.downloadRequestTimeoutMs = this.getPositiveNumberConfig('TELEGRAM_DOWNLOAD_TIMEOUT_MS', 5 * 60 * 1000);
    // 本地文件白名单根目录，如 /var/lib/telegram-bot-api 或容器内 tmp 目录
    this.localFileBase = this.configService.get<string>('TELEGRAM_LOCAL_FILE_DIR') || '';

    if (!this.botToken || this.botToken.startsWith('0000000000') || this.botToken === 'your-telegram-bot-token') {
      this.logger.warn('TELEGRAM_BOT_TOKEN 未配置或为占位符，文件上传将不可用。请在 .env 中设置有效的 Bot Token。');
    }
    if (!this.chatId) {
      this.logger.warn('TELEGRAM_CHAT_ID 未配置，文件上传将不可用。请在 .env 中设置 TELEGRAM_CHAT_ID。');
    }
  }

  private getPositiveNumberConfig(key: string, fallback: number): number {
    const value = Number(this.configService.get<string>(key));
    return Number.isFinite(value) && value > 0 ? value : fallback;
  }

  /**
   * 从字符串中移除 Bot Token，防止泄露到错误日志
   */
  private redactToken(str: string): string {
    return str.replace(/\/bot[^/]+\//g, '/bot[REDACTED]/');
  }

  /**
   * 包装 axios 请求，统一处理 Telegram API 错误，提供更友好的错误消息。
   * 429 限流时自动重试（最多 3 次，指数退避）。
   */
  private async telegramRequest<T>(fn: () => Promise<T>, label: string, retries = 3): Promise<T> {
    for (let attempt = 1; attempt <= retries; attempt++) {
      try {
        return await fn();
      } catch (error: unknown) {
        if (error && typeof error === 'object' && 'response' in error) {
          const axiosError = error as { response?: { status?: number; data?: { description?: string; parameters?: { retry_after?: number } } }; message?: string; config?: { url?: string } };
          const status = axiosError.response?.status;
          const description = axiosError.response?.data?.description || '';

          // 429 限流 — 使用 Telegram 返回的 retry_after 秒数等待后重试
          if (status === 429 && attempt < retries) {
            const retryAfter = axiosError.response?.data?.parameters?.retry_after || 3;
            const delay = Math.max(retryAfter * 1000, 1000);
            this.logger.warn(`${label} 触发限流 (429)，${attempt}/${retries} 次重试，等待 ${delay}ms...`);
            await new Promise(resolve => setTimeout(resolve, delay));
            continue;
          }
          if (status === 401) {
            throw new Error('Telegram Bot Token 无效，请联系管理员检查 TELEGRAM_BOT_TOKEN 配置');
          }
          if (status === 400) {
            if (description.includes('IMAGE_PROCESS_FAILED')) {
              throw new Error('图片处理失败，请确认文件为有效的图片格式');
            }
            if (description.includes('chat not found') || description.includes('PEER_ID_INVALID')) {
              throw new Error('Telegram 群组未找到，请检查 TELEGRAM_CHAT_ID 配置或确认 Bot 已加入群组');
            }
            throw new Error('Telegram API 请求参数错误，请检查 TELEGRAM_CHAT_ID 配置是否正确');
          }
          if (status === 404) {
            throw new Error('Telegram Bot 未找到，请检查 Bot Token 是否正确');
          }
          // 移除错误对象中可能包含 bot token 的 URL 信息，防止泄露到日志
          if (axiosError.message) {
            axiosError.message = this.redactToken(axiosError.message);
          }
          if (axiosError.config?.url) {
            axiosError.config.url = this.redactToken(axiosError.config.url);
          }
        }
        throw error;
      }
    }
    throw new Error(`Telegram API 请求失败: ${label}（已重试 ${retries} 次）`);
  }

  private getBaseUrl() {
    return `${this.apiBase}${this.botToken}`;
  }

  /**
   * 上传文件后立即调用 getFile 获取真实的 file_path
   */
  private async getFileInfo(fileId: string): Promise<{
    file_id: string;
    file_path: string;
    file_size: number;
  }> {
    try {
      return await this.telegramRequest(async () => {
        const response = await axios.get(`${this.getBaseUrl()}/getFile`, {
          params: { file_id: fileId },
          timeout: this.downloadRequestTimeoutMs,
        });
        const result = response.data.result;
        if (!result?.file_path) throw new Error('getFile 响应缺少 file_path');
        return {
          file_id: result.file_id || fileId,
          file_path: result.file_path,
          file_size: result.file_size || 0,
        };
      }, 'getFileInfo');
    } catch (error) {
      if (error instanceof Error && error.message === 'Telegram Bot 未找到，请检查 Bot Token 是否正确') {
        throw new Error('Telegram 文件已失效或 Bot API 无法解析该 file_id，请重新上传文件');
      }
      throw error;
    }
  }

  async uploadFile(
    file: Buffer | Readable,
    filename: string,
    signal?: AbortSignal,
    knownLength?: number,
  ): Promise<{
    file_id: string;
    file_path: string;
    file_size: number;
    message_id: string;
  }> {
    // 流式上传：form-data 支持 Readable stream，使用 knownLength 避免一次性读入内存
    const isStream = file instanceof Readable;
    // 流只能被消费一次：429 重试会复用已消费的流，导致重试必然失败或上传损坏。
    // 因此流式上传禁用自动重试（retries=1）；Buffer 上传可安全重发，保留 3 次重试。
    const retries = isStream ? 1 : 3;

    return this.telegramRequest(async () => {
      const form = new FormData();
      form.append('chat_id', this.chatId);

      if (isStream) {
        form.append('document', file, { filename, knownLength });
      } else {
        form.append('document', file, filename);
      }

      // 服务层上传体积上限（默认 2GB，对齐 Telegram 本地 Bot API 上限），可通过环境变量覆盖
      const maxSize = Number(process.env.TELEGRAM_MAX_UPLOAD_SIZE) || 2 * 1024 * 1024 * 1024;
      const response = await axios.post(`${this.getBaseUrl()}/sendDocument`, form, {
        headers: form.getHeaders(),
        timeout: 15 * 60 * 1000,           // 大文件上传超时 15 分钟
        maxContentLength: maxSize,
        maxBodyLength: maxSize,
        signal,
      });

      const result = response.data.result;
      const file_id = result.document?.file_id;
      if (!file_id) {
        throw new Error('Telegram sendDocument 响应缺少 document.file_id，可能文件格式不被支持');
      }

      // sendDocument 返回的 file_path 不可靠，需二次调用 getFile 获取真实路径；保留 message_id 用于删除消息。
      const info = await this.getFileInfo(file_id);
      return { ...info, message_id: String(result.message_id) };
    }, 'uploadFile', retries);
  }

  async uploadPhoto(
    file: Buffer,
    filename: string,
    signal?: AbortSignal,
  ): Promise<{
    file_id: string;
    file_path: string;
    file_size: number;
  }> {
    return this.telegramRequest(async () => {
      const form = new FormData();
      form.append('chat_id', this.chatId);
      form.append('photo', file, filename);

      const response = await axios.post(`${this.getBaseUrl()}/sendPhoto`, form, {
        headers: form.getHeaders(),
        timeout: 5 * 60 * 1000,          // Telegram API 请求超时 5 分钟
        maxContentLength: 700 * 1024 * 1024, // 最大请求体 700MB
        maxBodyLength: 700 * 1024 * 1024,
        signal,
      });

      const result = response.data.result;
      // sendPhoto 消息中可能包含多个尺寸，取最后一个（最大分辨率）的 file_id
      const photos = result.photo;
      if (!photos || photos.length === 0) {
        throw new Error('Telegram sendPhoto 响应缺少 photo 信息，可能文件格式不被支持');
      }
      const file_id = photos[photos.length - 1].file_id;

      // sendPhoto 返回的 file_path 不可靠，需二次调用 getFile 获取真实路径
      return this.getFileInfo(file_id);
    }, 'uploadPhoto');
  }

  private getFileUrl(file_path: string, base = this.fileBase): string {
    // 远程路径校验：禁止路径穿越
    if (file_path.includes('..') || file_path.includes('\\')) {
      throw new Error(`非法的 file_path: ${file_path}`);
    }
    // 本地 Bot API 返回绝对路径时，不拼接 HTTP URL
    if (file_path.startsWith('/')) {
      return file_path;
    }
    return `${base}${this.botToken}/${file_path}`;
  }

  private waitForFirstChunk(stream: Readable, timeoutMs: number, label: string): Promise<void> {
    return new Promise((resolve, reject) => {
      let timer: NodeJS.Timeout;
      const cleanup = () => {
        clearTimeout(timer);
        stream.off('readable', onReadable);
        stream.off('end', onEnd);
        stream.off('error', onError);
      };
      const onReadable = () => {
        cleanup();
        resolve();
      };
      const onEnd = () => {
        cleanup();
        reject(new Error(`${label} 在返回首字节前结束`));
      };
      const onError = (error: Error) => {
        cleanup();
        reject(error);
      };
      timer = setTimeout(() => {
        cleanup();
        reject(new Error(`${label} 首字节超时 (${timeoutMs}ms)`));
      }, timeoutMs);
      stream.once('readable', onReadable);
      stream.once('end', onEnd);
      stream.once('error', onError);
      // Axios 流可能在监听前已经进入 readable 状态。
      if (stream.readableLength > 0) onReadable();
    });
  }

  private async openRemoteFileStream(
    filePath: string,
    fileBase: string,
    firstByteTimeoutMs: number,
    label: string,
  ): Promise<Readable> {
    const response = await axios.get<Readable>(this.getFileUrl(filePath, fileBase), {
      responseType: 'stream',
      timeout: this.downloadRequestTimeoutMs,
    });
    const stream = response.data as Readable;
    try {
      await this.waitForFirstChunk(stream, firstByteTimeoutMs, label);
      return stream;
    } catch (error) {
      stream.destroy();
      throw error;
    }
  }

  private async openLocalFileStream(filePath: string): Promise<Readable> {
    const safePath = this.resolveLocalPath(filePath);
    let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
    try {
      // 先取得文件句柄再创建流，ENOENT/ESTALE/EIO 会作为 Promise rejection 被捕获，
      // 不会形成无人监听的 ReadStream error 事件。
      handle = await fs.open(safePath, 'r');
      const stream = handle.createReadStream({ autoClose: true });
      handle = undefined;
      return stream;
    } catch (error) {
      await handle?.close().catch(() => {});
      throw error;
    }
  }

  private isRecoverableLocalFileError(error: unknown): boolean {
    const code = error && typeof error === 'object' && 'code' in error
      ? String((error as NodeJS.ErrnoException).code || '')
      : '';
    return ['ENOENT', 'ESTALE', 'EIO', 'ENXIO'].includes(code);
  }

  private async openRefreshedFileById(
    fileId: string,
    fallbackSize: number,
  ): Promise<{ stream: Readable; info: { file_id: string; file_path: string; file_size: number } }> {
    const refreshed = await this.getFileInfo(fileId);
    const info = { ...refreshed, file_size: refreshed.file_size || fallbackSize };

    if (this.isLocalPath(refreshed.file_path)) {
      try {
        const stream = await this.openLocalFileStream(refreshed.file_path);
        return { stream, info };
      } catch (error) {
        if (this.isRecoverableLocalFileError(error)) {
          throw new Error('Telegram Bot API 返回的本地文件路径已失效，请恢复存储目录或重新上传文件');
        }
        throw error;
      }
    }

    const stream = await this.openRemoteFileStream(
      refreshed.file_path,
      this.fileBase,
      this.firstByteTimeoutMs,
      'Telegram Bot API 文件下载',
    );
    return { stream, info };
  }

  /**
   * 判断 file_path 是否为本地绝对路径（非 HTTP URL）
   */
  private isLocalPath(file_path: string): boolean {
    return file_path.startsWith('/');
  }

  /** 安全解析本地文件路径，防止路径穿越攻击 */
  private resolveLocalPath(filePath: string): string {
    // 1. 先在“原始”路径上检查 '..'。
    //    注意：绝不能先 normalize 再检查——normalize 会消除 '..' 段使检查形同虚设。
    if (filePath.includes('..')) {
      throw new Error('非法的本地文件路径');
    }

    // 2. 必须配置允许的本地文件根目录（白名单），否则拒绝（fail-closed）。
    if (!this.localFileBase) {
      this.logger.warn('收到本地文件路径请求，但未配置 TELEGRAM_LOCAL_FILE_DIR，已拒绝访问');
      throw new Error('本地文件访问未启用');
    }

    // 3. 解析为绝对路径并校验位于白名单目录内。
    //    对绝对 filePath，path.resolve(base, filePath) 返回 filePath 本身；
    //    对相对路径则基于 base 解析。校验时附带分隔符，防止 /base-evil 这类兄弟目录绕过。
    const allowlistedBase = path.resolve(this.localFileBase);
    const resolved = path.resolve(allowlistedBase, filePath);
    if (resolved !== allowlistedBase && !resolved.startsWith(allowlistedBase + path.sep)) {
      throw new Error('非法的本地文件路径');
    }

    return resolved;
  }

  async getFile(file_id: string): Promise<Buffer> {
    const fileInfo = await this.getFileInfo(file_id);
    const filePath = fileInfo.file_path;

    // 远程路径穿越校验
    if (!this.isLocalPath(filePath) && (filePath.includes('..') || filePath.includes('\\'))) {
      throw new Error(`非法的文件路径: ${filePath}`);
    }

    // 本地绝对路径：安全解析后从文件系统异步读取
    if (this.isLocalPath(filePath)) {
      const safePath = this.resolveLocalPath(filePath);
      try {
        // 直接读取并在失败时统一处理，避免 access→read 之间的 TOCTOU；
        // 错误信息不回显内部文件系统路径。
        return await fs.readFile(safePath);
      } catch {
        throw new Error('本地文件读取失败');
      }
    }

    // 远程下载：经 telegramRequest 包装，统一脱敏 bot token 并处理 429 重试
    const fileUrl = this.getFileUrl(filePath);
    const fileResponse = await this.telegramRequest(
      () => axios.get(fileUrl, {
        responseType: 'arraybuffer',
        timeout: 5 * 60 * 1000,
      }),
      'getFile',
    );

    return Buffer.from(fileResponse.data);
  }

  /**
   * 流式获取文件（避免大文件全部加载到内存）
   */
  async getFileStream(
    file_id: string,
    knownInfo?: { file_path?: string | null; file_size?: number },
  ): Promise<{ stream: Readable; info: { file_id: string; file_path: string; file_size: number } }> {
    // 优先使用数据库中的路径；旧本地路径失效时仅通过当前 TELEGRAM_API_BASE 刷新一次。
    const fileInfo = knownInfo?.file_path
      ? { file_id, file_path: knownInfo.file_path, file_size: knownInfo.file_size || 0 }
      : await this.getFileInfo(file_id);
    const filePath = fileInfo.file_path;

    if (this.isLocalPath(filePath)) {
      try {
        const stream = await this.openLocalFileStream(filePath);
        return { stream, info: fileInfo };
      } catch (localError) {
        if (!this.isRecoverableLocalFileError(localError)) throw localError;
        const code = (localError as NodeJS.ErrnoException).code || 'UNKNOWN';
        this.logger.warn(`Telegram 本地副本不可用，通过当前 Bot API 刷新路径: fileId=${file_id}, code=${code}`);
        return this.openRefreshedFileById(file_id, fileInfo.file_size);
      }
    }

    // 相对 file_path 才能拼接 /file/bot<TOKEN>/；绝对路径永远不会进入 HTTP 下载分支。
    const stream = await this.openRemoteFileStream(
      filePath,
      this.fileBase,
      this.firstByteTimeoutMs,
      'Telegram Bot API 文件下载',
    );
    return { stream, info: fileInfo };
  }

  /**
   * 从 Telegram 删除文件对应的消息
   * 通过 deleteMessage API 删除包含该文件的消息来实现文件移除。
   * 注意：此方法需要传入 message_id（即 telegramMessageId），
   * 不支持以 file_id 直接删除文件（Telegram Bot API 无此类端点）。
   *
   * 错误处理策略：
   * - 400 "message to delete not found" → 视为幂等成功
   * - 400 "message can't be deleted" → Bot 权限不足，仅记录警告
   * - 429 限流 → 自动等待 retry_after 后重试（最多 3 次）
   */
  async deleteFile(telegramMessageId: string): Promise<boolean> {
    if (!telegramMessageId || telegramMessageId.trim().length === 0) {
      this.logger.warn('deleteFile 收到空的 messageId，跳过删除操作');
      return false;
    }

    try {
      await this.telegramRequest(async () => {
        const response = await axios.post(
          `${this.getBaseUrl()}/deleteMessage`,
          {
            chat_id: this.chatId,
            message_id: telegramMessageId,
          },
          { timeout: 30 * 1000 },
        );

        if (!response.data?.ok) {
          throw new Error(`Telegram API 返回异常状态: ${JSON.stringify(response.data)}`);
        }
        this.logger.log(`已成功从 Telegram 删除消息，messageId: ${telegramMessageId}`);
      }, 'deleteFile');
    } catch (error: unknown) {
      const errMsg = error instanceof Error ? error.message : '未知错误';

      // 消息已被删除或不存在 → 幂等成功
      if (errMsg.includes('message to delete not found') || errMsg.includes('MESSAGE_ID_INVALID')) {
        this.logger.log(`Telegram 消息 ${telegramMessageId} 不存在，视为删除成功`);
        return true;
      }

      // Bot 权限不足 → 记录警告，不中断流程
      if (errMsg.includes("message can't be deleted")) {
        this.logger.warn(`Bot 无权限删除消息 ${telegramMessageId}，请确认 Bot 为群组管理员`);
        return false;
      }

      // 其他错误重新抛出
      throw error;
    }

    return true;
  }
}
