import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios from 'axios';
import { Readable } from 'stream';
import { createReadStream } from 'fs';
import { promises as fs } from 'fs';
import * as path from 'path';
import FormData from 'form-data';
import { TelegramFileNotFoundError, TelegramStreamPathError } from './telegram.errors';

interface TelegramMediaResult {
  document?: { file_id?: string };
  animation?: { file_id?: string };
  video?: { file_id?: string };
  audio?: { file_id?: string };
  voice?: { file_id?: string };
}

interface TelegramSendDocumentResponse {
  ok?: boolean;
  result?: TelegramMediaResult;
}

@Injectable()
export class TelegramService {
  private readonly logger = new Logger(TelegramService.name);
  private readonly botToken: string;
  private readonly chatId: string;
  private readonly apiBase: string;
  private readonly fileBase: string;
  private readonly fileStreamingEnabled: boolean;
  private readonly fileStreamingBase: string;
  private readonly fileStreamingTimeoutMs: number;
  /**
   * 本地 Bot API 文件存储的允许根目录（白名单）。
   * 自建 telegram-bot-api 时 getFile 可能返回本地绝对路径，
   * 仅允许读取此目录内的文件；未配置时本地读取将被拒绝（fail-closed）。
   */
  private readonly localFileBase: string;
  /**
   * 进程内恢复去重表（R9）：按 fileId 合并单次强制回源 Promise，
   * 避免共享同一 file_id 的复制记录并发触发重复回源。完成后立即删除。
   */
  private readonly recoveryInFlight = new Map<string, Promise<{ file_id: string; file_path: string; file_size: number }>>();

  constructor(private configService: ConfigService) {
    // 注意：botToken 在构造函数中一次性读取，不支持热更新
    // 如需更换 Token 需重启服务
    this.botToken = this.configService.get<string>('TELEGRAM_BOT_TOKEN') || '';
    this.chatId = this.configService.get<string>('TELEGRAM_CHAT_ID') || '';
    // 支持自建 API 代理绕过官方限流: 设置 TELEGRAM_API_BASE 即可
    // 默认 https://api.telegram.org，自建代理如 http://localhost:8081
    const base = this.configService.get<string>('TELEGRAM_API_BASE') || 'https://api.telegram.org';
    this.apiBase = `${base}/bot`;
    this.fileBase = `${base}/file/bot`;
    const streamingBaseConfig = this.configService.get<string>('TELEGRAM_FILE_STREAM_BASE')?.trim();
    // 显式配置二改 API 流式端口即视为启用，避免只设置新端口后仍静默走标准
    // /file/bot/<file_path> 下载；TELEGRAM_FILE_STREAMING_ENABLED=false 仍可强制关闭。
    const streamingEnabledConfig = this.configService.get<string>('TELEGRAM_FILE_STREAMING_ENABLED')?.trim().toLowerCase();
    this.fileStreamingEnabled = streamingEnabledConfig === 'false'
      ? false
      : streamingEnabledConfig === 'true' || Boolean(streamingBaseConfig);
    const streamingBase = streamingBaseConfig || base;
    this.fileStreamingBase = streamingBase.replace(/\/$/, '');
    const streamingTimeoutSeconds = Number(this.configService.get<string>('TELEGRAM_FILE_STREAM_TIMEOUT_SECONDS'));
    this.fileStreamingTimeoutMs = Number.isFinite(streamingTimeoutSeconds) && streamingTimeoutSeconds > 0
      ? streamingTimeoutSeconds * 1000
      : 120000;
    // 本地文件白名单根目录，如 /var/lib/telegram-bot-api 或容器内 tmp 目录
    this.localFileBase = this.configService.get<string>('TELEGRAM_LOCAL_FILE_DIR') || '';

    if (!this.botToken || this.botToken.startsWith('0000000000') || this.botToken === 'your-telegram-bot-token') {
      this.logger.warn('TELEGRAM_BOT_TOKEN 未配置或为占位符，文件上传将不可用。请在 .env 中设置有效的 Bot Token。');
    }
    if (!this.chatId) {
      this.logger.warn('TELEGRAM_CHAT_ID 未配置，文件上传将不可用。请在 .env 中设置 TELEGRAM_CHAT_ID。');
    }
  }

  /**
   * 从字符串中移除 Bot Token，防止泄露到错误日志。
   * G4-11：除 URL 形态（/bot<token>/）外，用 token 字面值全局替换，
   * 覆盖网络层错误 config.url 原样携带 token 的场景。
   */
  private redactToken(str: string): string {
    let out = str.replace(/\/bot[^/]+\//g, '/bot[REDACTED]/');
    if (this.botToken) {
      out = out.split(this.botToken).join('[REDACTED]');
    }
    return out;
  }

  /**
   * 对任意错误对象脱敏其中可能携带 Bot Token 的 message / config.url。
   * 必须在响应分支之外对所有错误执行（G4-11），网络层错误（无 response）
   * 同样可能把 token 原样带出。
   */
  private redactError(error: unknown): void {
    if (!error || typeof error !== 'object') return;
    const e = error as { message?: string; config?: { url?: string } };
    if (typeof e.message === 'string') {
      e.message = this.redactToken(e.message);
    }
    if (e.config && typeof e.config.url === 'string') {
      e.config.url = this.redactToken(e.config.url);
    }
  }

  /**
   * 安全化 Telegram 400 错误描述：脱敏 Bot Token、清理控制字符、
   * 规范化空白并限制长度，避免敏感信息或冗长响应进入日志与持久化字段。
   */
  private safeTelegramDescription(description: string): string {
    const cleaned = this.redactToken(description)
      .replace(/[\u0000-\u001F\u007F]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    if (!cleaned) return 'Telegram API 请求参数错误，请检查相关配置';
    return cleaned.slice(0, 500);
  }

  /**
   * 判断 Telegram 描述是否为“文件永久不存在”类错误。
   * 本地 Bot API / 官方 API 对失效 file_id 的描述格式不统一，
   * 常见变体：invalid file_id、file not found、FILE_ID_INVALID、file is too big 除外。
   */
  private isTelegramFileNotFoundError(description: string): boolean {
    const lower = description.toLowerCase();
    return (
      lower.includes('invalid file_id')
      || lower.includes('file not found')
      || lower.includes('file_id_invalid')
      || lower.includes('file does not exist')
      ||       lower.includes('file is not exist')
    );
  }

  /**
   * 判断 Telegram 描述是否为"本地路径失效 / 流式 size 不可用"型 502。
   * 仅匹配**确证**的路径失效特征（Bot API 自托管流式端点在旧路径失效、
   * 无法从 TDLib 获取精确文件大小时返回），避免把普通 502/网关错误误判。
   */
  private isTelegramStreamPathError(description: string): boolean {
    const safe = this.safeTelegramDescription(description).toLowerCase();
    // 不同 bot-api 构建版本的描述略有差异，但都明确表示流式端点无法取得
    // Telegram 文件大小；仅在这些确证特征下进入单次回源，普通 502 仍原样抛出。
    return (
      safe.includes('exact file size is unavailable from telegram')
      || safe.includes('file size is unavailable from telegram')
      || safe.includes('exact file size unavailable from telegram')
    );
  }

  /**
   * 包装 axios 请求，统一处理 Telegram API 错误，提供更友好的错误消息。
   * 429 限流时自动重试（最多 3 次，指数退避）。
   */
  private async telegramRequest<T>(fn: () => Promise<T>, label: string, retries = 3): Promise<T> {
    for (let attempt = 1; attempt <= retries; attempt++) {
      const startedAt = Date.now();
      try {
        return await fn();
      } catch (error: unknown) {
        // 网络层错误通常没有 response，原先会直接静默上抛，导致只能看到“上传失败”。
        // 在所有分支前记录安全摘要，便于区分 ECONNREFUSED、超时、连接重置和 HTTP 错误。
        this.redactError(error);
        const axiosError = error && typeof error === 'object'
          ? error as { response?: { status?: number; data?: { description?: string; parameters?: { retry_after?: number } } }; message?: string; code?: string; config?: { url?: string } }
          : undefined;
        const status = axiosError?.response?.status;
        const description = axiosError?.response?.data?.description || '';
        const errorCode = axiosError?.code || 'UNKNOWN';
        const errorErrno = axiosError && 'errno' in axiosError ? String((axiosError as { errno?: unknown }).errno ?? '') : '';
        const errorSyscall = axiosError && 'syscall' in axiosError ? String((axiosError as { syscall?: unknown }).syscall ?? '') : '';
        const transport = [errorCode, errorErrno, errorSyscall].filter(Boolean).join('/') || 'UNKNOWN';
        const detail = this.safeTelegramDescription(description || axiosError?.message || '未知错误');
        this.logger.warn(
          `Telegram 请求失败 label=${label} attempt=${attempt}/${retries} elapsed=${Date.now() - startedAt}ms `
          + `status=${status ?? 'none'} transport=${transport} response=${status === undefined ? 'none' : 'present'} reason=${detail}`,
        );

        if (error && typeof error === 'object' && 'response' in error) {
          const responseError = error as { response?: { status?: number; data?: { description?: string; parameters?: { retry_after?: number } } }; message?: string; config?: { url?: string } };
          const status = responseError.response?.status;
          const description = responseError.response?.data?.description || '';

          // 429 限流 — 使用 Telegram 返回的 retry_after 秒数等待后重试
          if (status === 429 && attempt < retries) {
            const retryAfter = responseError.response?.data?.parameters?.retry_after || 3;
            const delay = Math.max(retryAfter * 1000, 1000);
            this.logger.warn(`${label} 触发限流 (429)，${attempt}/${retries} 次重试，等待 ${delay}ms...`);
            await new Promise(resolve => setTimeout(resolve, delay));
            continue;
          }
          if (status === 401) {
            throw new Error('Telegram Bot Token 无效，请联系管理员检查 TELEGRAM_BOT_TOKEN 配置');
          }
          if (status === 400) {
            if (this.isTelegramFileNotFoundError(description)) {
              // file_id 失效属于“文件永久不存在”类错误，抛类型化异常供调用方精确降级，
              // 不再让用户误以为 TELEGRAM_CHAT_ID 配置有误。
              throw new TelegramFileNotFoundError(
                `Telegram 文件不存在或已失效：${this.safeTelegramDescription(description)}`,
              );
            }
            if (description.includes('IMAGE_PROCESS_FAILED')) {
              throw new Error('图片处理失败，请确认文件为有效的图片格式');
            }
            if (description.includes('chat not found') || description.includes('PEER_ID_INVALID')) {
              throw new Error('Telegram 群组未找到，请检查 TELEGRAM_CHAT_ID 配置或确认 Bot 已加入群组');
            }
            // 保留 Telegram 原始 description（安全化后），不再统一归因为 chat_id 配置错误
            throw new Error(this.safeTelegramDescription(description));
          }
          if (status === 404) {
            if (this.isTelegramFileNotFoundError(description)) {
              throw new TelegramFileNotFoundError(
                `Telegram 文件不存在或已失效：${this.safeTelegramDescription(description)}`,
              );
            }
            throw new Error('Telegram Bot 未找到，请检查 Bot Token 是否正确');
          }
          // R1：二改流式端点的任意 HTTP 502 都进入一次受控回源。
          // 该端点在不同构建版本/代理下可能返回不同 description；对于专用
          // /stream/file 请求，502 本身已足以说明当前 TDLib 流上下文不可用。
          // 回源仍有严格的一次边界，且回源中的超时/429/普通 5xx 不会被转成永久错误。
          if (status === 502 && label === 'getRealtimeFileStream') {
            const reason = this.isTelegramStreamPathError(description)
              ? this.safeTelegramDescription(description)
              : '二改流式端点返回 502';
            throw new TelegramStreamPathError(`Telegram 文件流上下文不可用：${reason}`);
          }
        }
        // G4-11：脱敏移到 response 分支之外——网络层错误（无 response，
        // 如 ECONNREFUSED/DNS）的 config.url 同样可能原样携带 Bot Token。
        this.redactError(error);
        throw error;
      }
    }
    throw new Error(`Telegram API 请求失败: ${label}（已重试 ${retries} 次）`);
  }

  private getBaseUrl() {
    return `${this.apiBase}${this.botToken}`;
  }

  /**
   * 调用 Telegram /getFile 获取元数据，不请求 /file/bot... 下载地址，不传输文件内容。
   * 上传提交后的路径解析允许较长等待；批量体检使用独立短超时，避免单项探测拖慢整批。
   */
  private async getFileInfo(
    file_id: string,
    timeoutMs = 5 * 60 * 1000,
    label = 'getFileInfo',
    metadataOnly = false,
  ): Promise<{
    file_id: string;
    file_path: string;
    file_size: number;
  }> {
    return this.telegramRequest(async () => {
      const response = await axios.get(`${this.getBaseUrl()}/getFile`, {
        params: { file_id, ...(metadataOnly ? { metadata_only: true } : {}) },
        timeout: timeoutMs,
      });
      const result = response.data.result;
      return {
        file_id: result.file_id,
        // metadata_only 不触发 downloadFile，因此不会返回本地 file_path；体检只需成功响应即可。
        file_path: result.file_path || '',
        file_size: result.file_size || 0,
      };
    }, label);
  }

  /**
   * 轻量校验 file_id：仅调用 /getFile 获取元数据，Telegram 成功返回即视为有效。
   * 不下载文件内容；file_id 永久失效时抛 TelegramFileNotFoundError，超时等暂时性错误保持原类型。
   */
  async verifyFileExists(file_id: string): Promise<{
    file_id: string;
    file_path: string;
    file_size: number;
  }> {
    if (!file_id || file_id.length > 4096) {
      throw new TelegramFileNotFoundError('非法的 Telegram file_id');
    }
    return this.getFileInfo(file_id, 15 * 1000, 'verifyFileExists', true);
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
      const response = await axios.post<TelegramSendDocumentResponse>(`${this.getBaseUrl()}/sendDocument`, form, {
        headers: form.getHeaders(),
        timeout: 15 * 60 * 1000,           // 大文件上传超时 15 分钟
        maxContentLength: maxSize,
        maxBodyLength: maxSize,
        signal,
      });

      const result = response.data?.result;
      // 自托管 Bot API 即使接收 sendDocument，也可能按内容重新识别媒体类型：
      // MP4 可能被识别为 animation/video，MP3/OGG 等音频可能被识别为 audio/voice。
      // 普通 document 保持优先，避免多媒体字段并存时改变现有文件行为。
      const file_id = result?.document?.file_id
        || result?.animation?.file_id
        || result?.video?.file_id
        || result?.audio?.file_id
        || result?.voice?.file_id;
      if (!file_id) {
        const mediaFields = result && typeof result === 'object'
          ? Object.keys(result).filter((key) => key !== 'text').slice(0, 10).join(', ') || 'none'
          : 'none';
        this.logger.warn(`Telegram sendDocument 响应缺少可识别的媒体 file_id（字段: ${mediaFields}）`);
        throw new Error('Telegram sendDocument 响应缺少可识别的媒体 file_id');
      }

      // sendDocument 返回的 file_path 不可靠，需二次调用 getFile 获取真实路径
      return this.getFileInfo(file_id);
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

  private getFileUrl(file_path: string): string {
    // 远程路径校验：禁止路径穿越
    if (file_path.includes('..') || file_path.includes('\\')) {
      throw new Error(`非法的 file_path: ${file_path}`);
    }
    // 本地 Bot API 返回绝对路径时，不拼接 HTTP URL
    if (file_path.startsWith('/')) {
      return file_path;
    }
    return `${this.fileBase}${this.botToken}/${file_path}`;
  }

  /**
   * 判断 file_path 是否为本地绝对路径（非 HTTP URL）。
   * 支持 Unix/Linux 绝对路径（`/...`）、Windows 绝对路径（`C:\...`、`C:/...`）
   * 及 UNC 路径（`\\server\share`）。
   */
  private isLocalPath(file_path: string): boolean {
    if (file_path.startsWith('/')) return true;
    return /^[a-zA-Z]:[\\/]/.test(file_path) || file_path.startsWith('\\\\');
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

  /**
   * 安全打开本地文件流（R3）：在 createReadStream 前先 fs.promises.open/stat
   * 确认路径存在且为文件，将 ENOENT/无法打开 同步转为可恢复的
   * TelegramStreamPathError，避免延迟的 stream error 越过恢复边界。
   * 打开成功后由调用方通过返回的句柄建立流（句柄由流关闭时释放）。
   */
  private async openLocalStream(filePath: string): Promise<{ stream: Readable; release: () => void }> {
    const safePath = this.resolveLocalPath(filePath);
    let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
    try {
      handle = await fs.open(safePath, 'r');
      const stat = await handle.stat();
      if (!stat.isFile()) {
        await handle.close();
        handle = undefined; // 已关闭，避免 catch 分支二次 close
        this.logger.warn('Telegram 本地路径不是常规文件，拒绝打开（路径类别: 本地文件）');
        throw new TelegramStreamPathError('Telegram 文件本地路径不是常规文件');
      }
      // 以打开的句柄建立流，避免 open→createReadStream 之间的 TOCTOU；
      // 句柄由流的 close 事件自动释放。
      const stream = createReadStream(safePath, { fd: handle });
      handle = undefined; // 所有权已转移给流
      return { stream, release: () => { /* fd 由流持有并自动关闭 */ } };
    } catch (error: unknown) {
      if (handle) {
        try { await handle.close(); } catch { /* 忽略关闭失败 */ }
      }
      // ENOENT / 无法打开 → 可恢复路径失效错误
      if (error instanceof TelegramStreamPathError) throw error;
      this.logger.warn(`Telegram 本地文件无法打开（类别: 本地路径失效）`);
      throw new TelegramStreamPathError('Telegram 文件本地路径失效，无法打开');
    }
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
   * 通过二次开发 Bot API 的独立 file_id 端点实时获取完整文件。
   * 该端点在 TDLib 完成整文件下载前即可返回连续字节，不支持 Range。
   * opts.noCache：无缓存直通时携带 X-Telegram-No-Cache 头，
   * Bot API 完整传输后会删除 TDLib workdir 中的本地副本（仅流式端点路径支持）。
   */
  async getRealtimeFileStream(fileId: string, expectedSize?: number, opts?: { noCache?: boolean }): Promise<{
    stream: Readable;
    info: { file_id: string; file_path: string; file_size: number };
  }> {
    if (!this.fileStreamingEnabled) {
      // getFileStream 回退路径不支持 no-cache 清理，忽略 opts
      return this.getFileStream(fileId);
    }
    if (!fileId || fileId.length > 4096) {
      throw new Error('非法的 Telegram file_id');
    }
    if (expectedSize !== undefined && (!Number.isSafeInteger(expectedSize) || expectedSize <= 0)) {
      throw new Error('非法的预期文件大小');
    }

    // 请求头按需构造：大小提示与 no-cache 清理可独立/同时携带
    const headers: Record<string, string> = {};
    if (expectedSize !== undefined) headers['X-Telegram-File-Size'] = String(expectedSize);
    if (opts?.noCache) headers['X-Telegram-No-Cache'] = '1';

    // 首次 streaming 请求（retries=1）。若命中 R1 路径失效型 502 抛
    // TelegramStreamPathError，则进入单次强制回源恢复路径。
    try {
      return await this.requestRealtimeStream(fileId, expectedSize, headers);
    } catch (error: unknown) {
      // R2：仅对"路径失效型 502"执行单次强制回源，其余错误原样抛出
      if (!(error instanceof TelegramStreamPathError)) {
        throw error;
      }
      this.logger.warn(
        `Telegram 实时流因本地路径失效触发回源（类别: 路径失效型 502）`,
      );
      return await this.recoverRealtimeStream(fileId, expectedSize, headers);
    }
  }

  /**
   * 执行一次真正的 streaming 请求并校验响应（提取自 getRealtimeFileStream）。
   */
  private async requestRealtimeStream(
    fileId: string,
    expectedSize: number | undefined,
    headers: Record<string, string>,
  ): Promise<{ stream: Readable; info: { file_id: string; file_path: string; file_size: number } }> {
    const url = `${this.fileStreamingBase}/stream/file/bot${this.botToken}/${encodeURIComponent(fileId)}`;
    const response = await this.telegramRequest(
      () => axios.get<Readable>(url, {
        responseType: 'stream',
        timeout: this.fileStreamingTimeoutMs,
        maxRedirects: 0,
        headers: Object.keys(headers).length > 0 ? headers : undefined,
      }),
      'getRealtimeFileStream',
      1,
    );
    const rawLength = response.headers['content-length'];
    const fileSize = Number(Array.isArray(rawLength) ? rawLength[0] : rawLength);
    if (!Number.isSafeInteger(fileSize) || fileSize <= 0) {
      (response.data as Readable).destroy();
      throw new Error('Telegram 实时流响应缺少有效的 Content-Length');
    }
    if (expectedSize !== undefined && fileSize !== expectedSize) {
      (response.data as Readable).destroy();
      throw new Error(`Telegram 实时流文件大小不一致: 期望 ${expectedSize}, 实际 ${fileSize}`);
    }

    return {
      stream: response.data as Readable,
      info: { file_id: fileId, file_path: '', file_size: fileSize },
    };
  }

  /**
   * 单次强制回源（R2）：对"路径失效型 502"执行一次非 metadata_only 的
   * getFile（触发 Bot API 实际下载），成功后用新 file_path 安全打开本地流返回。
   *
   * 流程约束（禁止递归/无限重试）：
   *   - 整体最多 streaming 1 次（已发生）+ getFile 1 次 + streaming 1 次（恢复路径）。
   *   - 回源成功且返回非空 file_path → 返回 getFileStream 风格结果（本地安全打开）。
   *   - 回源成功但 file_path 为空 → 再次尝试 streaming 一次并返回其结果；
   *     仍失败则抛永久错误。
   *   - 回源失败（TelegramFileNotFoundError 等）→ 抛永久不可用错误。
   *
   * R9：按 fileId 在进程内合并回源 Promise，避免共享 file_id 的复制记录
   * 并发重复回源；完成后立即释放。
   */
  private async recoverRealtimeStream(
    fileId: string,
    expectedSize: number | undefined,
    headers: Record<string, string>,
  ): Promise<{ stream: Readable; info: { file_id: string; file_path: string; file_size: number } }> {
    // R9：复用进程内进行中的回源 Promise（key = fileId），避免重复回源
    const inFlight = this.recoveryInFlight.get(fileId);
    if (inFlight) {
      try {
        const info = await inFlight;
        return await this.openRecoveredStream(fileId, expectedSize, headers, info);
      } catch (error) {
        // 复用到的回源失败：与自身回源失败同等处理，抛永久错误
        throw this.toPermanentRecoveryError(error);
      }
    }

    // 发起一次真正触发 Bot API 下载的 getFile（metadataOnly=false，短超时 60s）
    const recovery = this.getFileInfo(fileId, 60 * 1000, 'recoverRealtimeStream', false)
      .finally(() => {
        // 完成后立即释放，避免长期占用
        this.recoveryInFlight.delete(fileId);
      });
    this.recoveryInFlight.set(fileId, recovery);

    try {
      const info = await recovery;
      return await this.openRecoveredStream(fileId, expectedSize, headers, info);
    } catch (error) {
      throw this.toPermanentRecoveryError(error);
    }
  }

  /**
   * 根据回源后的 file_info 建立流：
   * - 非空 file_path → 走 getFileStream 风格（本地安全打开 / 远程流）。
   * - 空 file_path（Bot API 无本地路径）→ 再尝试 streaming 一次并返回其结果；
   *   仍失败则抛永久错误。
   */
  private async openRecoveredStream(
    fileId: string,
    expectedSize: number | undefined,
    headers: Record<string, string>,
    info: { file_id: string; file_path: string; file_size: number },
  ): Promise<{ stream: Readable; info: { file_id: string; file_path: string; file_size: number } }> {
    if (info.file_path) {
      // 回源成功且返回有效本地路径 → 传统 getFileStream 风格结果（安全打开）
      return this.getFileStream(fileId);
    }
    // file_path 为空：Bot API 无本地路径，再次尝试 streaming 一次
    try {
      return await this.requestRealtimeStream(fileId, expectedSize, headers);
    } catch (error) {
      throw this.toPermanentRecoveryError(error);
    }
  }

  /**
   * 将回源失败统一转换为上层可识别的错误。
   * 仅当回源明确返回 TelegramFileNotFoundError（Telegram 永久不存在）时，
   * 才包装为"恢复失败，判定永久不可用"供上层标记 error；
   * 其余原因（超时、429、普通 5xx、网络中断等暂时性错误）原样抛出，
   * 保持原错误类型，避免把瞬时故障误判为永久失效而误标文件。
   */
  private toPermanentRecoveryError(cause: unknown): Error {
    if (cause instanceof TelegramFileNotFoundError) {
      return new TelegramFileNotFoundError(`Telegram 文件恢复失败，判定永久不可用：${cause.message}`);
    }
    if (cause instanceof Error) {
      // 暂时性错误：保持原类型抛出，不包装成永久错误
      throw cause;
    }
    throw new Error('Telegram 文件恢复失败');
  }

  /**
   * 流式获取文件（避免大文件全部加载到内存）
   */
  async getFileStream(file_id: string): Promise<{ stream: Readable; info: { file_id: string; file_path: string; file_size: number } }> {
    const fileInfo = await this.getFileInfo(file_id);
    const filePath = fileInfo.file_path;

    let stream: Readable;
    if (this.isLocalPath(filePath)) {
      // R3：先安全打开确认存在再建立流，ENOENT 转为可恢复错误
      const opened = await this.openLocalStream(filePath);
      stream = opened.stream;
    } else {
      // 远程下载经 telegramRequest 包装，统一脱敏 bot token 并处理 429 重试
      const response = await this.telegramRequest(
        () => axios.get<Readable>(this.getFileUrl(filePath), {
          responseType: 'stream',
          timeout: 5 * 60 * 1000,
        }),
        'getFileStream',
      );
      stream = response.data as Readable;
    }

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
