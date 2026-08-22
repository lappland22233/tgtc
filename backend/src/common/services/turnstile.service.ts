import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios from 'axios';
import { ConfigCacheService } from './config-cache.service';
import { decryptPassword } from '../utils/crypto.util';

const TURNSTILE_VERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';
const MAX_TOKEN_LENGTH = 2048;

interface TurnstileVerifyResponse {
  success?: boolean;
  action?: string;
  hostname?: string;
}

/** Cloudflare Turnstile 服务端校验。对调用方只暴露业务布尔结果，不泄露 Cloudflare 响应结构。 */
@Injectable()
export class TurnstileService {
  constructor(
    private readonly configService: ConfigService,
    private readonly configCacheService: ConfigCacheService,
  ) {}

  /**
   * 校验指定业务动作的 Turnstile token。
   * 任何配置缺失、输入非法、超时、网络异常或 Cloudflare 返回失败都拒绝通过。
   */
  async verify(token: unknown, action: string, expectedHostnames?: string[]): Promise<boolean> {
    if (typeof token !== 'string' || token.length === 0 || token.length > MAX_TOKEN_LENGTH) {
      return false;
    }

    try {
      const configuredSecret = await this.configCacheService.get('TURNSTILE_SECRET_KEY', '');
      const secret = configuredSecret
        ? decryptPassword(configuredSecret)
        : (this.configService.get<string>('TURNSTILE_SECRET_KEY') || '');
      if (!secret) return false;

      const body = new URLSearchParams({ secret, response: token });
      const response = await axios.post<TurnstileVerifyResponse>(TURNSTILE_VERIFY_URL, body, {
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        timeout: 5000,
        // Cloudflare 校验不需要跟随重定向，避免把 secret 发送到非预期地址。
        maxRedirects: 0,
      });
      const result = response.data;

      if (result?.success !== true || result.action !== action || typeof result.hostname !== 'string' || result.hostname.length === 0) {
        return false;
      }
      if (!expectedHostnames || expectedHostnames.length === 0) return false;
      return expectedHostnames.some((hostname) => result.hostname!.toLowerCase() === hostname.toLowerCase());
    } catch {
      // 不记录 token、secret 或 Cloudflare 原始响应；失败默认拒绝。
      return false;
    }
  }
}
