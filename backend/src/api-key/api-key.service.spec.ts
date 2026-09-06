import { BadRequestException, NotFoundException, UnauthorizedException } from '@nestjs/common';
import { createHash } from 'crypto';
import { ApiKeyService } from './api-key.service';
import { ApiKey } from '../common/entities/api-key.entity';
import { User, UserRole } from '../common/entities/user.entity';
import { attachApiKeyContext, getApiKeyContext, hasAdminPrivileges } from '../common/auth-context';

/** 构造带 keyHash 的模拟密钥行 */
function mockKeyEntity(overrides: Partial<ApiKey> = {}): ApiKey {
  const raw = 'tgtc_test';
  return {
    id: 'key-1',
    userId: 'user-1',
    name: '测试密钥',
    prefix: 'tgtc_test',
    keyHash: createHash('sha256').update(raw, 'utf8').digest('hex'),
    lastUsedAt: null,
    revokedAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  } as ApiKey;
}

describe('ApiKeyService', () => {
  let service: ApiKeyService;
  let apiKeyRepo: { findOne: jest.Mock; find: jest.Mock; count: jest.Mock; create: jest.Mock; save: jest.Mock; update: jest.Mock };
  let userRepo: { findOne: jest.Mock };
  let auditService: { log: jest.Mock };

  const activeUser = { id: 'user-1', email: 'a@b.c', role: UserRole.USER, isBanned: false } as User;
  const adminUser = { id: 'user-2', email: 'admin@b.c', role: UserRole.ADMIN, isBanned: false } as User;

  beforeEach(() => {
    apiKeyRepo = {
      findOne: jest.fn(),
      find: jest.fn().mockResolvedValue([]),
      count: jest.fn().mockResolvedValue(0),
      create: jest.fn((x) => x),
      save: jest.fn(async (x) => ({ id: 'new-key-id', createdAt: new Date(), ...x })),
      update: jest.fn().mockResolvedValue({ affected: 1 }),
    };
    userRepo = { findOne: jest.fn() };
    auditService = { log: jest.fn() };

    service = new ApiKeyService(
      apiKeyRepo as never,
      userRepo as never,
      auditService as never,
    );
  });

  describe('create', () => {
    it('明文密钥只出现一次，服务端只保存 SHA-256 摘要', async () => {
      apiKeyRepo.save.mockImplementation(async (x) => ({ id: 'new-key-id', createdAt: new Date(), ...x }));

      const created = await service.create(activeUser, '我的密钥');

      expect(created.key).toMatch(/^tgtc_[A-Za-z0-9_-]{40,}$/);
      // 保存的实体只含摘要，不含明文
      const saved = apiKeyRepo.save.mock.calls[0][0] as ApiKey;
      expect(saved.keyHash).toBe(createHash('sha256').update(created.key, 'utf8').digest('hex'));
      expect(JSON.stringify(saved)).not.toContain(created.key);
      expect(saved.name).toBe('我的密钥');
    });

    it('达到密钥数量上限时拒绝创建', async () => {
      apiKeyRepo.count.mockResolvedValue(20);
      await expect(service.create(activeUser)).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  describe('authenticate', () => {
    it('有效密钥返回附带 owner-only 上下文的用户', async () => {
      const key = mockKeyEntity();
      apiKeyRepo.findOne.mockResolvedValue(key);
      userRepo.findOne.mockResolvedValue(activeUser);

      const raw = 'tgtc_test';
      const user = await service.authenticate(raw);

      expect(user.id).toBe('user-1');
      const ctx = getApiKeyContext(user);
      expect(ctx).toEqual({ keyId: 'key-1', keyName: '测试密钥', prefix: 'tgtc_test' });
    });

    it('已撤销密钥返回 401', async () => {
      apiKeyRepo.findOne.mockResolvedValue(mockKeyEntity({ revokedAt: new Date() }));
      await expect(service.authenticate('tgtc_test')).rejects.toBeInstanceOf(UnauthorizedException);
    });

    it('未知摘要（伪造密钥）返回 401', async () => {
      apiKeyRepo.findOne.mockResolvedValue(null);
      await expect(service.authenticate('tgtc_fake')).rejects.toBeInstanceOf(UnauthorizedException);
    });

    it('封禁账号的密钥返回 401', async () => {
      apiKeyRepo.findOne.mockResolvedValue(mockKeyEntity());
      userRepo.findOne.mockResolvedValue({ ...activeUser, isBanned: true });
      await expect(service.authenticate('tgtc_test')).rejects.toBeInstanceOf(UnauthorizedException);
    });
  });

  describe('revoke / rotate 的 owner 边界', () => {
    it('不能撤销他人的密钥（NotFound 不泄露存在性）', async () => {
      apiKeyRepo.findOne.mockResolvedValue(mockKeyEntity({ userId: 'someone-else' }));
      await expect(service.revoke(activeUser, 'key-1')).rejects.toBeInstanceOf(NotFoundException);
    });

    it('轮换会撤销旧密钥并返回新明文', async () => {
      apiKeyRepo.findOne.mockResolvedValue(mockKeyEntity());
      const created = await service.rotate(activeUser, 'key-1', '新名字');
      expect(apiKeyRepo.update).toHaveBeenCalledWith('key-1', expect.objectContaining({ revokedAt: expect.any(Date) }));
      expect(created.key).toMatch(/^tgtc_/);
      expect(created.name).toBe('新名字');
    });

    it('已撤销的密钥不能轮换', async () => {
      apiKeyRepo.findOne.mockResolvedValue(mockKeyEntity({ revokedAt: new Date() }));
      await expect(service.rotate(activeUser, 'key-1')).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  describe('owner-only 管理员边界（auth-context）', () => {
    it('管理员账号经 JWT 认证具备越权能力', () => {
      expect(hasAdminPrivileges(adminUser)).toBe(true);
    });

    it('同一管理员账号经 API Key 认证后不具备越权能力', () => {
      const viaApiKey = attachApiKeyContext({ ...adminUser } as User, {
        keyId: 'key-1',
        keyName: '测试',
        prefix: 'tgtc_x',
      });
      expect(hasAdminPrivileges(viaApiKey)).toBe(false);
    });

    it('API Key 上下文标记不可枚举（不落入序列化/日志）', () => {
      const viaApiKey = attachApiKeyContext({ ...activeUser } as User, {
        keyId: 'key-1',
        keyName: '测试',
        prefix: 'tgtc_x',
      });
      expect(JSON.stringify(viaApiKey)).not.toContain('keyId');
      expect(Object.keys(viaApiKey).some((k) => k.toLowerCase().includes('apikey'))).toBe(false);
    });
  });
});
