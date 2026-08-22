import axios from 'axios';
import { ConfigService } from '@nestjs/config';
import { TurnstileService } from './turnstile.service';
import { ConfigCacheService } from './config-cache.service';

jest.mock('axios');
const mockedAxios = axios as jest.Mocked<typeof axios>;

describe('TurnstileService', () => {
  const configService = { get: jest.fn() } as unknown as ConfigService;
  const configCacheService = { get: jest.fn() } as unknown as ConfigCacheService;
  let service: TurnstileService;

  beforeEach(() => {
    jest.clearAllMocks();
    configService.get = jest.fn().mockReturnValue('test-secret');
    configCacheService.get = jest.fn().mockResolvedValue('');
    service = new TurnstileService(configService, configCacheService);
  });

  it('rejects empty and overlong tokens without a request', async () => {
    await expect(service.verify('', 'register')).resolves.toBe(false);
    await expect(service.verify('x'.repeat(2049), 'register')).resolves.toBe(false);
    expect(mockedAxios.post).not.toHaveBeenCalled();
  });

  it('accepts only successful responses with the expected action and hostname', async () => {
    mockedAxios.post.mockResolvedValue({ data: { success: true, action: 'register', hostname: 'example.com' } } as any);
    await expect(service.verify('token', 'register', ['example.com'])).resolves.toBe(true);
    await expect(service.verify('token', 'reset_password', ['example.com'])).resolves.toBe(false);
    await expect(service.verify('token', 'register', ['other.example.com'])).resolves.toBe(false);
  });

  it('rejects missing hostname, Cloudflare failures, and network errors', async () => {
    mockedAxios.post.mockResolvedValueOnce({ data: { success: true, action: 'register' } } as any);
    await expect(service.verify('token', 'register')).resolves.toBe(false);
    mockedAxios.post.mockResolvedValueOnce({ data: { success: false, action: 'register', hostname: 'example.com' } } as any);
    await expect(service.verify('token', 'register')).resolves.toBe(false);
    mockedAxios.post.mockRejectedValueOnce(new Error('network failure'));
    await expect(service.verify('token', 'register')).resolves.toBe(false);
  });

  it('rejects malformed encrypted configuration without a request', async () => {
    configCacheService.get = jest.fn().mockResolvedValue('v2:malformed');
    await expect(service.verify('token', 'register')).resolves.toBe(false);
    expect(mockedAxios.post).not.toHaveBeenCalled();
  });
});
