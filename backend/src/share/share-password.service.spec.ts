import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Test } from '@nestjs/testing';
import { BannedIP } from '../common/entities/banned-ip.entity';
import { ConfigCacheService } from '../common/services/config-cache.service';
import { RateLimitService } from '../common/services/rate-limit.service';
import { SharePasswordService } from './share-password.service';

describe('SharePasswordService', () => {
  const bannedRepo = { upsert: jest.fn(), createQueryBuilder: jest.fn() };
  const rateLimit = {
    checkAndIncrement: jest.fn(),
    incrementCounter: jest.fn(),
    reset: jest.fn(),
  };
  let service: SharePasswordService;

  beforeEach(async () => {
    const module = await Test.createTestingModule({
      providers: [
        SharePasswordService,
        { provide: getRepositoryToken(BannedIP), useValue: bannedRepo },
        { provide: RateLimitService, useValue: rateLimit },
        { provide: ConfigCacheService, useValue: { get: jest.fn().mockResolvedValue('5') } },
        { provide: ConfigService, useValue: { get: jest.fn().mockReturnValue('secret') } },
        { provide: JwtService, useValue: { sign: jest.fn() } },
      ],
    }).compile();
    service = module.get(SharePasswordService);
    jest.clearAllMocks();
  });

  it('在 bcrypt 前同时检查 token 与 IP 限流', async () => {
    rateLimit.checkAndIncrement.mockResolvedValue({ allowed: true });
    await expect(service.checkPasswordAttemptAllowed('127.0.0.1', 'share-token')).resolves.toBe(true);
    expect(rateLimit.checkAndIncrement).toHaveBeenCalledTimes(2);
    expect(rateLimit.checkAndIncrement).toHaveBeenCalledWith(
      'share-password:token:share-token', 'share_password_precheck', 10, 60000, 60000,
    );
    expect(rateLimit.checkAndIncrement).toHaveBeenCalledWith(
      'share-password:ip:127.0.0.1', 'share_password_precheck', 10, 60000, 60000,
    );
  });

  it('任一维度锁定时拒绝昂贵密码验证', async () => {
    rateLimit.checkAndIncrement
      .mockResolvedValueOnce({ allowed: true })
      .mockResolvedValueOnce({ allowed: false, waitMinutes: 1 });
    await expect(service.checkPasswordAttemptAllowed('127.0.0.1', 'share-token')).resolves.toBe(false);
  });

  it('使用明确计数 API 触发临时封禁且不传零锁定时长', async () => {
    rateLimit.incrementCounter
      .mockResolvedValueOnce({ count: 5, thresholdReached: true })
      .mockResolvedValueOnce({ count: 1, thresholdReached: false });
    await service.recordFailedAttempt('127.0.0.1');
    expect(rateLimit.incrementCounter).toHaveBeenNthCalledWith(
      1, 'pwd:127.0.0.1', 'password_error', 5, 3600000,
    );
    expect(bannedRepo.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ ip: '127.0.0.1', isPermanent: false, expiresAt: expect.any(Date) }),
      ['ip'],
    );
    expect(rateLimit.reset).toHaveBeenCalledWith('pwd:127.0.0.1');
  });
});
