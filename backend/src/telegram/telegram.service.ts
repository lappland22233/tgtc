import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios from 'axios';
import { Readable } from 'stream';
import FormData from 'form-data';

@Injectable()
export class TelegramService {
  private readonly botToken: string;
  private readonly chatId: string;
  private readonly apiBase = 'https://api.telegram.org/bot';

  constructor(private configService: ConfigService) {
    this.botToken = this.configService.get<string>('TELEGRAM_BOT_TOKEN') || '';
    this.chatId = this.configService.get<string>('TELEGRAM_CHAT_ID') || '';

    if (!this.botToken || this.botToken.startsWith('0000000000') || this.botToken === 'your-telegram-bot-token') {
      console.warn('[Telegram] TELEGRAM_BOT_TOKEN 未配置或为占位符，文件上传将不可用。请在 .env 中设置有效的 Bot Token。');
    }
    if (!this.chatId) {
      console.warn('[Telegram] TELEGRAM_CHAT_ID 未配置，文件上传将不可用。请在 .env 中设置 TELEGRAM_CHAT_ID。');
    }
  }

  /**
   * 包装 axios 请求，统一处理 Telegram API 错误，提供更友好的错误消息
   */
  private async telegramRequest<T>(fn: () => Promise<T>, label: string): Promise<T> {
    try {
      return await fn();
    } catch (error: unknown) {
      if (error && typeof error === 'object' && 'response' in error) {
        const axiosError = error as { response?: { status?: number; data?: { description?: string } } };
        const status = axiosError.response?.status;
        const description = axiosError.response?.data?.description || '';
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
      }
      throw error;
    }
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
    });

    const result = response.data.result;
    const file_id = result.document.file_id;

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
    });

    const result = response.data.result;
    // sendPhoto 消息中可能包含多个尺寸，取最后一个（最大分辨率）的 file_id
    const file_id = result.photo[result.photo.length - 1].file_id;

    // sendPhoto 返回的 file_path 不可靠，需二次调用 getFile 获取真实路径
    return this.getFileInfo(file_id);
    }, 'uploadPhoto');
  }

  private getFileUrl(file_path: string): string {
    return `https://api.telegram.org/file/bot${this.botToken}/${file_path}`;
  }

  async getFile(file_id: string): Promise<Buffer> {
    const fileInfo = await this.getFileInfo(file_id);
    const fileUrl = this.getFileUrl(fileInfo.file_path);

    const fileResponse = await axios.get(fileUrl, {
      responseType: 'arraybuffer',
    });

    return Buffer.from(fileResponse.data);
  }

  /**
   * 流式获取文件（避免大文件全部加载到内存）
   */
  async getFileStream(file_id: string): Promise<{ stream: Readable; info: { file_id: string; file_path: string; file_size: number } }> {
    const fileInfo = await this.getFileInfo(file_id);
    const fileUrl = this.getFileUrl(fileInfo.file_path);

    const fileResponse = await axios.get<Readable>(fileUrl, {
      responseType: 'stream',
    });

    return { stream: fileResponse.data as Readable, info: fileInfo };
  }

  async deleteFile(file_id: string): Promise<boolean> {
    return true;
  }
}
