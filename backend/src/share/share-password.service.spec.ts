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

  it('在 bcrypt 前同时检查 token、IP 与 token-lock 限流', async () => {
    rateLimit.checkAndIncrement.mockResolvedValue({ allowed: true });
    await expect(service.checkPasswordAttemptAllowed('127.0.0.1', 'share-token')).resolves.toBe(true);
    // G5-08：新增 token-lock 键作为 24h 累计失败锁定探针，共 3 个维度
    expect(rateLimit.checkAndIncrement).toHaveBeenCalledTimes(3);
    expect(rateLimit.checkAndIncrement).toHaveBeenCalledWith(
      'share-password:token:share-token', 'share_password_precheck', 10, 60000, 60000,
    );
    expect(rateLimit.checkAndIncrement).toHaveBeenCalledWith(
      'share-password:ip:127.0.0.1', 'share_password_precheck', 10, 60000, 60000,
    );
    // token-lock 用极大 maxAttempts 作为纯锁定探针，正常不触发锁定，仅在被锁定时返回 false
    expect(rateLimit.checkAndIncrement).toHaveBeenCalledWith(
      'share-password:token-lock:share-token', 'share_password_precheck', Number.MAX_SAFE_INTEGER, 60000, 60000,
    );
  });

  it('任一维度锁定时拒绝昂贵密码验证', async () => {
    rateLimit.checkAndIncrement
      .mockResolvedValueOnce({ allowed: true })
      .mockResolvedValueOnce({ allowed: false, waitMinutes: 1 })
      .mockResolvedValueOnce({ allowed: true });
    await expect(service.checkPasswordAttemptAllowed('127.0.0.1', 'share-token')).resolves.toBe(false);
  });

  it('token 已被 24h 累计锁定（G5-08）时拒绝验证', async () => {
    // token-lock 探针返回 allowed=false 表示该 token 已锁定
    rateLimit.checkAndIncrement
      .mockResolvedValueOnce({ allowed: true }) // token 短窗
      .mockResolvedValueOnce({ allowed: true }) // ip 短窗
      .mockResolvedValueOnce({ allowed: false, waitMinutes: 1440 }); // token-lock 24h
    await expect(service.checkPasswordAttemptAllowed('127.0.0.1', 'share-token')).resolves.toBe(false);
  });

  it('累计失败达阈值（G5-08）后对 token 加 24h 锁并重置计数', async () => {
    // incrementCounter 返回 count=30 达到阈值（3 窗口 × 10 次）
    rateLimit.incrementCounter.mockResolvedValue({ count: 30, thresholdReached: true });
    rateLimit.checkAndIncrement.mockResolvedValue({ allowed: false, waitMinutes: 1440 });
    await service.recordTokenFailedAttempt('share-token');
    expect(rateLimit.incrementCounter).toHaveBeenCalledWith(
      'share-password:token-fail:share-token', 'share_password_token_fail', 1, 3600000,
    );
    // 24h 锁定触发
    expect(rateLimit.checkAndIncrement).toHaveBeenCalledWith(
      'share-password:token-lock:share-token', 'share_password_token_lock', 1, 24 * 3600 * 1000, 3600000,
    );
    // 重置累计失败计数，便于下一轮
    expect(rateLimit.reset).toHaveBeenCalledWith('share-password:token-fail:share-token');
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
