import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios from 'axios';
import { Readable } from 'stream';
import { createReadStream, readFileSync, existsSync } from 'fs';
import FormData from 'form-data';

@Injectable()
export class TelegramService {
  private readonly botToken: string;
  private readonly chatId: string;
  private readonly apiBase: string;
  private readonly fileBase: string;

  constructor(private configService: ConfigService) {
    this.botToken = this.configService.get<string>('TELEGRAM_BOT_TOKEN') || '';
    this.chatId = this.configService.get<string>('TELEGRAM_CHAT_ID') || '';
    // 支持自建 API 代理绕过官方限流: 设置 TELEGRAM_API_BASE 即可
    // 默认 https://api.telegram.org，自建代理如 http://localhost:8081
    const base = this.configService.get<string>('TELEGRAM_API_BASE') || 'https://api.telegram.org';
    this.apiBase = `${base}/bot`;
    this.fileBase = `${base}/file/bot`;

    if (!this.botToken || this.botToken.startsWith('0000000000') || this.botToken === 'your-telegram-bot-token') {
      console.warn('[Telegram] TELEGRAM_BOT_TOKEN 未配置或为占位符，文件上传将不可用。请在 .env 中设置有效的 Bot Token。');
    }
    if (!this.chatId) {
      console.warn('[Telegram] TELEGRAM_CHAT_ID 未配置，文件上传将不可用。请在 .env 中设置 TELEGRAM_CHAT_ID。');
    }
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
            console.warn(`[Telegram] ${label} 触发限流 (429)，${attempt}/${retries} 次重试，等待 ${delay}ms...`);
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
  private async getFileInfo(file_id: string): Promise<{
    file_id: string;
    file_path: string;
    file_size: number;
  }> {
    return this.telegramRequest(async () => {
    const response = await axios.get(`${this.getBaseUrl()}/getFile`, {
      params: { file_id },
      timeout: 30 * 1000, // getFile 超时 30 秒（轻量 API）
    });
    const result = response.data.result;
    return {
      file_id: result.file_id,
      file_path: result.file_path,
      file_size: result.file_size || 0,
    };
    }, 'getFileInfo');
  }

  async uploadFile(file: Buffer, filename: string): Promise<{
    file_id: string;
    file_path: string;
    file_size: number;
  }> {
    return this.telegramRequest(async () => {
    const form = new FormData();
    form.append('chat_id', this.chatId);
    form.append('document', file, filename);

    const response = await axios.post(`${this.getBaseUrl()}/sendDocument`, form, {
      headers: form.getHeaders(),
      timeout: 5 * 60 * 1000,          // Telegram API 请求超时 5 分钟
      maxContentLength: 700 * 1024 * 1024, // 最大请求体 700MB
      maxBodyLength: 700 * 1024 * 1024,
    });

    const result = response.data.result;
    const file_id = result.document?.file_id;
    if (!file_id) {
      throw new Error('Telegram sendDocument 响应缺少 document.file_id，可能文件格式不被支持');
    }

    // sendDocument 返回的 file_path 不可靠，需二次调用 getFile 获取真实路径
    return this.getFileInfo(file_id);
    }, 'uploadFile');
  }

  async uploadPhoto(file: Buffer, filename: string): Promise<{
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
    // 本地 Bot API 返回绝对路径时，不拼接 HTTP URL
    if (file_path.startsWith('/')) {
      return file_path;
    }
    return `${this.fileBase}${this.botToken}/${file_path}`;
  }

  /**
   * 判断 file_path 是否为本地绝对路径（非 HTTP URL）
   */
  private isLocalPath(file_path: string): boolean {
    return file_path.startsWith('/');
  }

  async getFile(file_id: string): Promise<Buffer> {
    const fileInfo = await this.getFileInfo(file_id);
    const filePath = fileInfo.file_path;

    // 本地绝对路径：直接从文件系统读取
    if (this.isLocalPath(filePath)) {
      if (!existsSync(filePath)) {
        throw new Error(`文件不存在: ${filePath}`);
      }
      return readFileSync(filePath);
    }

    const fileUrl = this.getFileUrl(filePath);
    const fileResponse = await axios.get(fileUrl, {
      responseType: 'arraybuffer',
      timeout: 5 * 60 * 1000,
    });

    return Buffer.from(fileResponse.data);
  }

  /**
   * 流式获取文件（避免大文件全部加载到内存）
   */
  async getFileStream(file_id: string): Promise<{ stream: Readable; info: { file_id: string; file_path: string; file_size: number } }> {
    const fileInfo = await this.getFileInfo(file_id);
    const filePath = fileInfo.file_path;

    return {
      stream: this.isLocalPath(filePath)
        ? createReadStream(filePath)
        : (await axios.get<Readable>(this.getFileUrl(filePath), {
            responseType: 'stream',
            timeout: 5 * 60 * 1000,
          })).data as Readable,
      info: fileInfo,
    };
  }

  async deleteFile(_file_id: string): Promise<boolean> {
    return true;
  }
}
