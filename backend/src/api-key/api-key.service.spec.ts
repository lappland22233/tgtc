import { BadRequestException, NotFoundException, UnauthorizedException } from '@nestjs/common';
import { createHash } from 'crypto';
import { ApiKeyService } from './api-key.service';
import { ApiKey } from '../common/entities/api-key.entity';
import { ApiKeyIpAllowlist } from '../common/entities/api-key-ip-allowlist.entity';
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
    keyCipher: null,
    cipherVersion: null,
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
  let allowlistRepo: { find: jest.Mock };
  let cryptoService: { isAvailable: jest.Mock; encrypt: jest.Mock; decrypt: jest.Mock };
  let usageService: { record: jest.Mock; assertKeyOwnedForMutation: jest.Mock };
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
    allowlistRepo = { find: jest.fn().mockResolvedValue([]) };
    cryptoService = {
      isAvailable: jest.fn().mockReturnValue(true),
      encrypt: jest.fn(() => 'v1:aXZ2ZWN0aXZl:tag:cGlwZXJ0ZXh0'),
      decrypt: jest.fn(() => 'tgtc_test'),
    };
    usageService = {
      record: jest.fn(),
      assertKeyOwnedForMutation: jest.fn(async () => mockKeyEntity()),
    };
    auditService = { log: jest.fn() };

    service = new ApiKeyService(
      apiKeyRepo as never,
      userRepo as never,
      allowlistRepo as never,
      auditService as never,
      cryptoService as never,
      usageService as never,
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

    it('命中 IP 白名单的请求允许通过（v1.2.6）', async () => {
      apiKeyRepo.findOne.mockResolvedValue(mockKeyEntity());
      userRepo.findOne.mockResolvedValue(activeUser);
      allowlistRepo.find.mockResolvedValue([
        { id: 'r1', apiKeyId: 'key-1', rule: '10.0.0.0/8' } as ApiKeyIpAllowlist,
      ]);

      const user = await service.authenticate('tgtc_test', '10.1.2.3');
      expect(user.id).toBe('user-1');
      expect(usageService.record).not.toHaveBeenCalled();
    });

    it('IP 不在白名单时 fail-closed 拒绝并记录 denied_ip（v1.2.6）', async () => {
      apiKeyRepo.findOne.mockResolvedValue(mockKeyEntity());
      userRepo.findOne.mockResolvedValue(activeUser);
      allowlistRepo.find.mockResolvedValue([
        { id: 'r1', apiKeyId: 'key-1', rule: '10.0.0.0/8' } as ApiKeyIpAllowlist,
      ]);

      await expect(service.authenticate('tgtc_test', '203.0.113.9')).rejects.toBeInstanceOf(
        UnauthorizedException,
      );
      expect(usageService.record).toHaveBeenCalledWith(
        expect.objectContaining({ result: 'denied_ip', statusCode: 401, ip: '203.0.113.9' }),
      );
    });

    it('白名单非空且 IP 不可判定时拒绝（fail-closed）', async () => {
      apiKeyRepo.findOne.mockResolvedValue(mockKeyEntity());
      userRepo.findOne.mockResolvedValue(activeUser);
      allowlistRepo.find.mockResolvedValue([
        { id: 'r1', apiKeyId: 'key-1', rule: '10.0.0.0/8' } as ApiKeyIpAllowlist,
      ]);

      await expect(service.authenticate('tgtc_test')).rejects.toBeInstanceOf(UnauthorizedException);
    });
  });

  describe('所有者重显（v1.2.6）', () => {
    it('所有者可重显新密钥明文并写审计', async () => {
      apiKeyRepo.findOne.mockResolvedValue(mockKeyEntity({ keyCipher: 'v1:aXZ2ZWN0aXZl:tag:cGlwZXJ0ZXh0', cipherVersion: 'v1' }));
      const result = await service.reveal(activeUser, 'key-1');
      expect(result.key).toBe('tgtc_test');
      expect(auditService.log).toHaveBeenCalled();
    });

    it('他人的密钥重显返回 404', async () => {
      apiKeyRepo.findOne.mockResolvedValue(mockKeyEntity({ userId: 'someone-else', keyCipher: 'v1:x:y:z' }));
      await expect(service.reveal(activeUser, 'key-1')).rejects.toBeInstanceOf(NotFoundException);
    });

    it('旧版仅存 hash 的密钥不可重显', async () => {
      apiKeyRepo.findOne.mockResolvedValue(mockKeyEntity());
      await expect(service.reveal(activeUser, 'key-1')).rejects.toBeInstanceOf(BadRequestException);
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
