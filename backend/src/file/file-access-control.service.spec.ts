import 'reflect-metadata';
import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import * as bcrypt from 'bcryptjs';
import { FileAccessControlService } from './file-access-control.service';
import { FileAccessType } from '../common/entities/file.entity';
import { ShareTargetType } from '../common/entities/share-link.entity';
// UserRole 是枚举（非字符串联合），必须引用枚举成员
import { UserRole, type User } from '../common/entities/user.entity';

/**
 * M6 拆分回归：访问策略 / 密码 / IP 封禁域从 FileService 抽出为独立服务后，
 * 权限与边界语义必须与拆分前完全一致（该域直接关系文件访问安全）。
 */

const ownerId = '11111111-1111-4111-8111-111111111111';
const otherId = '22222222-2222-4222-8222-222222222222';

function makeUser(id: string, role: UserRole = UserRole.USER): User {
  return { id, role } as User;
}

/** 可链式调用的 QueryBuilder 替身 */
function queryBuilder(result: unknown) {
  const chain: Record<string, jest.Mock> = {} as Record<string, jest.Mock>;
  for (const method of ['update', 'set', 'where', 'andWhere']) chain[method] = jest.fn(() => chain);
  chain.execute = jest.fn().mockResolvedValue(result);
  chain.getOne = jest.fn().mockResolvedValue(result);
  return chain;
}

describe('FileAccessControlService（M6 拆分契约）', () => {
  let service: FileAccessControlService;
  let fileRepo: any;
  let bannedRepo: any;
  let audit: { log: jest.Mock };
  let configCache: { get: jest.Mock };
  let rateLimit: { incrementCounter: jest.Mock; reset: jest.Mock };

  beforeEach(() => {
    fileRepo = {
      findOne: jest.fn(),
      update: jest.fn().mockResolvedValue(undefined),
      createQueryBuilder: jest.fn(),
      manager: {
        transaction: jest.fn(async (cb: (m: unknown) => Promise<unknown>) =>
          cb({ getRepository: () => fileRepo })),
      },
    };
    bannedRepo = { createQueryBuilder: jest.fn(), upsert: jest.fn().mockResolvedValue(undefined) };
    audit = { log: jest.fn() };
    configCache = { get: jest.fn(async (_key: string, fallback: string) => fallback) };
    rateLimit = { incrementCounter: jest.fn(), reset: jest.fn().mockResolvedValue(undefined) };

    service = new FileAccessControlService(
      fileRepo, bannedRepo, audit as never, configCache as never, rateLimit as never,
    );
  });

  describe('updateAccessType', () => {
    it('文件不存在抛 404，不写库', async () => {
      fileRepo.findOne.mockResolvedValue(null);

      await expect(service.updateAccessType('f', FileAccessType.PUBLIC, makeUser(ownerId)))
        .rejects.toThrow(NotFoundException);
      expect(fileRepo.update).not.toHaveBeenCalled();
    });

    it('非所有者且非管理员抛 403（写权限校验）', async () => {
      fileRepo.findOne.mockResolvedValue({ id: 'f', uploaderId: ownerId, isDeleted: false });

      await expect(service.updateAccessType('f', FileAccessType.PUBLIC, makeUser(otherId)))
        .rejects.toThrow(ForbiddenException);
    });

    it('管理员可修改他人文件', async () => {
      fileRepo.findOne.mockResolvedValue({ id: 'f', uploaderId: ownerId, isDeleted: false });

      await expect(service.updateAccessType('f', FileAccessType.PUBLIC, makeUser(otherId, UserRole.ADMIN)))
        .resolves.toBeUndefined();
    });

    it('转为公平时不撤销 legacy 分享', async () => {
      fileRepo.findOne.mockResolvedValue({ id: 'f', uploaderId: ownerId, isDeleted: false });

      await service.updateAccessType('f', FileAccessType.PUBLIC, makeUser(ownerId));

      // 事务内仅执行一次文件属性更新，未触发 legacy 分享撤销分支
      expect(fileRepo.update).toHaveBeenCalledWith('f', { accessType: FileAccessType.PUBLIC });
      expect(fileRepo.createQueryBuilder).not.toHaveBeenCalled();
    });

    it('转为私有时在同一事务内软删 legacy 分享，并把撤销数量写入审计', async () => {
      fileRepo.findOne.mockResolvedValue({ id: 'f', uploaderId: ownerId, isDeleted: false });
      fileRepo.createQueryBuilder.mockReturnValue(queryBuilder({ affected: 2 }));

      await service.updateAccessType('f', FileAccessType.PRIVATE, makeUser(ownerId));

      expect(fileRepo.manager.transaction).toHaveBeenCalledTimes(1);
      // legacy token = 文件 ID 本身，必须作为参数与 varchar token 比较（禁止 token = targetId）
      const qb = fileRepo.createQueryBuilder.mock.results[0].value;
      // 撤销条件：targetType=file、targetId=文件 ID、token=文件 ID（legacy）、未删除
      expect(qb.where).toHaveBeenCalledWith('"targetType" = :targetType', { targetType: ShareTargetType.FILE });
      expect(qb.andWhere).toHaveBeenCalledWith('"targetId" = :id', { id: 'f' });
      expect(qb.andWhere).toHaveBeenCalledWith('"token" = :legacyToken', { legacyToken: 'f' });
      expect(qb.andWhere).toHaveBeenCalledWith('"isDeleted" = false');
      expect(audit.log).toHaveBeenCalledWith(expect.objectContaining({
        action: 'file_access_change',
        metadata: { accessType: FileAccessType.PRIVATE, revokedLegacyShares: 2 },
      }));
    });
  });

  describe('updateAccessCount', () => {
    beforeEach(() => {
      fileRepo.findOne.mockResolvedValue({ id: 'f', uploaderId: ownerId, isDeleted: false });
    });

    it('未配置上限（maxLimit <= 0）时不校验取值范围', async () => {
      await service.updateAccessCount('f', 999999, makeUser(ownerId), -1);

      expect(fileRepo.update).toHaveBeenCalledWith('f', { maxAccessCount: 999999 });
    });

    it('配置上限时超出范围抛 400，且不写库', async () => {
      await expect(service.updateAccessCount('f', 0, makeUser(ownerId), 5))
        .rejects.toThrow(BadRequestException);
      await expect(service.updateAccessCount('f', 6, makeUser(ownerId), 5))
        .rejects.toThrow(BadRequestException);
      expect(fileRepo.update).not.toHaveBeenCalled();

      await service.updateAccessCount('f', 5, makeUser(ownerId), 5);
      expect(fileRepo.update).toHaveBeenCalledWith('f', { maxAccessCount: 5 });
    });
  });

  describe('setPassword / updateExpires', () => {
    beforeEach(() => {
      fileRepo.findOne.mockResolvedValue({ id: 'f', uploaderId: ownerId, isDeleted: false });
    });

    it('空密码写入 null 并记录移除审计', async () => {
      await service.setPassword('f', '', makeUser(ownerId));

      expect(fileRepo.update).toHaveBeenCalledWith('f', { password: null });
      expect(audit.log).toHaveBeenCalledWith(expect.objectContaining({ action: 'file_password_remove' }));
    });

    it('非空密码以 bcrypt 哈希入库，审计不包含明文', async () => {
      await service.setPassword('f', 'secret', makeUser(ownerId));

      const [, payload] = fileRepo.update.mock.calls[0];
      expect(payload.password).not.toBe('secret');
      expect(await bcrypt.compare('secret', payload.password)).toBe(true);
      expect(audit.log).toHaveBeenCalledWith(expect.objectContaining({ action: 'file_password_set' }));
      expect(JSON.stringify(audit.log.mock.calls)).not.toContain('secret');
    });

    it('有效期置空时同时清空起始时间', async () => {
      await service.updateExpires('f', null, makeUser(ownerId));
      expect(fileRepo.update).toHaveBeenCalledWith('f', { expiresIn: null, expiresStartAt: null });

      await service.updateExpires('f', 24, makeUser(ownerId));
      const [, payload] = fileRepo.update.mock.calls[1];
      expect(payload.expiresIn).toBe(24);
      expect(payload.expiresStartAt).toBeInstanceOf(Date);
    });
  });

  describe('访问校验', () => {
    it('无密码文件视为验证通过', async () => {
      fileRepo.findOne.mockResolvedValueOnce(null).mockResolvedValueOnce({ password: null });

      await expect(service.verifyPassword('f', 'x')).resolves.toBe(true);
      await expect(service.verifyPassword('f', 'x')).resolves.toBe(true);
    });

    it('有密码文件按 bcrypt 比对', async () => {
      fileRepo.findOne.mockResolvedValue({ password: await bcrypt.hash('ok', 4) });

      await expect(service.verifyPassword('f', 'ok')).resolves.toBe(true);
      await expect(service.verifyPassword('f', 'bad')).resolves.toBe(false);
    });

    it('checkAndIncrementAccess 覆盖不存在/过期/耗尽/放行四种结果', async () => {
      fileRepo.findOne.mockResolvedValueOnce(null);
      await expect(service.checkAndIncrementAccess('f')).resolves.toEqual({ allowed: false, reason: '文件不存在' });

      fileRepo.findOne.mockResolvedValueOnce({
        expiresIn: 1, expiresStartAt: new Date(Date.now() - 7_200_000), maxAccessCount: -1,
      });
      await expect(service.checkAndIncrementAccess('f')).resolves.toEqual({ allowed: false, reason: '文件分享已过期' });

      fileRepo.findOne.mockResolvedValueOnce({ maxAccessCount: 3, expiresIn: null });
      fileRepo.createQueryBuilder.mockReturnValueOnce(queryBuilder({ affected: 1 }));
      await expect(service.checkAndIncrementAccess('f')).resolves.toEqual({ allowed: true });

      fileRepo.findOne.mockResolvedValueOnce({ maxAccessCount: 3, expiresIn: null });
      fileRepo.createQueryBuilder.mockReturnValueOnce(queryBuilder({ affected: 0 }));
      await expect(service.checkAndIncrementAccess('f')).resolves.toEqual({ allowed: false, reason: '文件访问次数已用尽' });
    });

    it('hasPassword / isPrivateFile 依据查询结果判定', async () => {
      fileRepo.findOne.mockResolvedValueOnce(null).mockResolvedValueOnce({ password: 'x' });
      await expect(service.hasPassword('f')).resolves.toBe(false);
      await expect(service.hasPassword('f')).resolves.toBe(true);

      fileRepo.findOne
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce({ accessType: FileAccessType.PRIVATE })
        .mockResolvedValueOnce({ accessType: FileAccessType.PUBLIC });
      await expect(service.isPrivateFile('f')).resolves.toBe(false);
      await expect(service.isPrivateFile('f')).resolves.toBe(true);
      await expect(service.isPrivateFile('f')).resolves.toBe(false);
    });
  });

  describe('IP 封禁与密码错误计数', () => {
    it('未封禁返回 banned:false；永久封禁与临时封禁文案不同', async () => {
      bannedRepo.createQueryBuilder.mockReturnValueOnce(queryBuilder(null));
      await expect(service.isIPBanned('1.2.3.4')).resolves.toEqual({ banned: false });

      bannedRepo.createQueryBuilder.mockReturnValueOnce(queryBuilder({ isPermanent: true }));
      await expect(service.isIPBanned('1.2.3.4')).resolves.toEqual(
        expect.objectContaining({ banned: true, message: expect.stringContaining('永久') }),
      );

      bannedRepo.createQueryBuilder.mockReturnValueOnce(queryBuilder({
        isPermanent: false, expiresAt: new Date(Date.now() + 120_000),
      }));
      await expect(service.isIPBanned('1.2.3.4')).resolves.toEqual(
        expect.objectContaining({ banned: true, message: expect.stringContaining('分钟') }),
      );
    });

    it('未达错误阈值时只计数，不写封禁记录', async () => {
      rateLimit.incrementCounter.mockResolvedValueOnce({ thresholdReached: false, count: 1 });

      await service.recordFailedPasswordAttempt('1.2.3.4');

      expect(bannedRepo.upsert).not.toHaveBeenCalled();
      expect(rateLimit.reset).not.toHaveBeenCalled();
    });

    it('达到阈值且为首次封禁时按动态时长封禁，并重置错误计数', async () => {
      rateLimit.incrementCounter
        .mockResolvedValueOnce({ thresholdReached: true, count: 5 })
        .mockResolvedValueOnce({ count: 1 });

      await service.recordFailedPasswordAttempt('1.2.3.4');

      expect(bannedRepo.upsert).toHaveBeenCalledTimes(1);
      const [record] = bannedRepo.upsert.mock.calls[0];
      expect(record).toMatchObject({ ip: '1.2.3.4', isPermanent: false });
      // 默认 sec_pwd_ban_duration=5 分钟
      expect(record.expiresAt.getTime()).toBeGreaterThan(Date.now() + 4 * 60_000);
      expect(rateLimit.reset).toHaveBeenCalledWith('pwd:1.2.3.4');
      expect(rateLimit.reset).not.toHaveBeenCalledWith('ban:1.2.3.4');
    });

    it('1 小时内连续封禁达到上限时升级为 6 小时并重置封禁计数', async () => {
      rateLimit.incrementCounter
        .mockResolvedValueOnce({ thresholdReached: true, count: 5 })
        .mockResolvedValueOnce({ count: 5 });

      await service.recordFailedPasswordAttempt('1.2.3.4');

      const [record] = bannedRepo.upsert.mock.calls[0];
      expect(record.reason).toContain('升级为6小时');
      expect(record.expiresAt.getTime()).toBeGreaterThan(Date.now() + 5.9 * 3600 * 1000);
      expect(rateLimit.reset).toHaveBeenCalledWith('ban:1.2.3.4');
    });

    it('封禁时长与阈值来自安全配置（热更新）', async () => {
      configCache.get.mockImplementation(async (key: string, fallback: string) => {
        if (key === 'sec_pwd_error_limit') return '3';
        if (key === 'sec_pwd_ban_duration') return '10';
        return fallback;
      });
      rateLimit.incrementCounter
        .mockResolvedValueOnce({ thresholdReached: true, count: 3 })
        .mockResolvedValueOnce({ count: 1 });

      await service.recordFailedPasswordAttempt('1.2.3.4');

      expect(rateLimit.incrementCounter).toHaveBeenCalledWith('pwd:1.2.3.4', 'password_error', 3, expect.any(Number));
      const [record] = bannedRepo.upsert.mock.calls[0];
      expect(record.reason).toContain('密码错误3次');
      expect(record.expiresAt.getTime()).toBeGreaterThan(Date.now() + 9 * 60_000);
    });
  });
});
