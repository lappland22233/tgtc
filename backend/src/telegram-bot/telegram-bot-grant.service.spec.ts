import { TelegramBotGrantService } from './telegram-bot-grant.service';
import { TelegramBotTokenCryptoService } from './telegram-bot-token-crypto.service';
import { ConfigService } from '@nestjs/config';
import type { TelegramBotFileGrant } from '../common/entities/telegram-bot-file-grant.entity';

/**
 * 构造可观测的 Repository 替身（只覆盖本服务被测试路径用到的方法）。
 *
 * `find` 由用例按需覆写；默认返回空数组（模拟无命中）。
 */
function makeContext() {
  const repository = {
    create: jest.fn((input: Partial<TelegramBotFileGrant>) => input),
    save: jest.fn(async (input: Partial<TelegramBotFileGrant>) => ({ ...input, id: input.id ?? 'grant-1' })),
    find: jest.fn(async (_options?: { take?: number }) => [] as unknown[]),
    findOne: jest.fn<Promise<Partial<TelegramBotFileGrant> | null>, [unknown]>(async () => null),
    update: jest.fn(async () => ({ affected: 1 })),
  };
  const tokenCrypto = {
    // 根密钥缺失的降级路径（tokenCipher=null）即可满足落库断言
    encrypt: jest.fn(() => null),
    cipherVersion: jest.fn(() => 'v1'),
  };
  const service = new TelegramBotGrantService(repository as never, tokenCrypto as never);
  return { service, repository, tokenCrypto };
}

/** 最小合法 issue 入参（各用例按需覆盖） */
function makeIssueInput(overrides: Partial<Parameters<TelegramBotGrantService['issue']>[0]> = {}) {
  return {
    telegramUserId: '900000123',
    username: null,
    displayName: null,
    chatId: '7001',
    messageId: '100',
    telegramFileId: 'FILE-1',
    fileName: null,
    mimeType: null,
    fileSize: null,
    sourceAccountId: '1234567',
    receiverBotId: '1234567',
    ...overrides,
  };
}

describe('TelegramBotGrantService（grant 内容标识与归因查询）', () => {
  it('无专用加密密钥时重启仍能恢复队列待发送的链接，常规回放仍遵循配置', async () => {
    const { repository } = makeContext();
    const crypto = () => new TelegramBotTokenCryptoService(new ConfigService({
      JWT_SECRET: 'local-test-secret-with-sufficient-length', TELEGRAM_BOT_ENCRYPTION_KEY: '',
    }));
    const service = new TelegramBotGrantService(repository as never, crypto());
    const { grant, token } = await service.issue(makeIssueInput(), 1, undefined, 'task-a');
    const restarted = new TelegramBotGrantService(repository as never, crypto());
    expect(grant.tokenCipher).toBeNull();
    expect(restarted.replayToken(grant)).toBeNull();
    expect(restarted.tokenForQueuedNotice(grant, 'task-a')).toBe(token);
    expect(restarted.tokenForQueuedNotice(grant, 'task-b')).toBeNull();
  });

  it('历史消息仅凭匹配的 Bot 专属 file_id 登记接收身份', async () => {
    const { service, repository } = makeContext();
    repository.findOne.mockResolvedValueOnce(null).mockResolvedValueOnce({ id: 'old' });
    await expect(service.findByMessage('u', 'c', 'm', '45', 'file-45')).resolves.toMatchObject({ id: 'old' });
    expect(repository.findOne.mock.calls[0][0]).toEqual({ where: { telegramUserId: 'u', chatId: 'c', messageId: 'm', receiverBotId: '45' } });
    expect(repository.findOne.mock.calls[1][0]).toMatchObject({ where: { telegramFileId: 'file-45' } });
    expect(repository.update).toHaveBeenCalledWith(expect.objectContaining({ id: 'old' }), { receiverBotId: '45' });
  });

  it('撤销只更新仍有效授权的撤销字段，保留并发写入的缓存引用', async () => {
    const { service, repository } = makeContext();
    expect(await service.revoke({ id: 'old', revokedAt: null } as TelegramBotFileGrant, 'admin')).toBe(true);
    expect(repository.update).toHaveBeenCalledWith(expect.objectContaining({ id: 'old' }), { revokedAt: expect.any(Date), revokedBy: 'admin' });
    expect(repository.save).not.toHaveBeenCalled();
  });

  describe('findByFileUniqueId（跨群认领归因）', () => {
    it('空串/空白串直接返回空数组且不查库（不得用空串查库）', async () => {
      const { service, repository } = makeContext();

      await expect(service.findByFileUniqueId('')).resolves.toEqual([]);
      await expect(service.findByFileUniqueId('   ')).resolves.toEqual([]);

      expect(repository.find).not.toHaveBeenCalled();
    });

    it('命中多条时按 createdAt DESC 排序并截断到 limit（排序/截断委托给数据库）', async () => {
      const { service, repository } = makeContext();
      const rows = [
        { id: 'g-old', createdAt: new Date('2026-01-01') },
        { id: 'g-new', createdAt: new Date('2026-03-01') },
        { id: 'g-mid', createdAt: new Date('2026-02-01') },
      ];
      // 复刻数据库语义：ORDER BY createdAt DESC + LIMIT take（验证服务把这两个约束完整下推）
      repository.find.mockImplementation(async (options?: { take?: number }) => (
        [...rows]
          .sort((left, right) => right.createdAt.getTime() - left.createdAt.getTime())
          .slice(0, options?.take ?? rows.length)
      ));

      const result = await service.findByFileUniqueId('UNIQ-1', 2);

      expect(result.map((row) => row.id)).toEqual(['g-new', 'g-mid']);
      expect(repository.find).toHaveBeenCalledWith({
        where: { fileUniqueId: 'UNIQ-1' },
        order: { createdAt: 'DESC' },
        take: 2,
      });
    });

    it('默认取最近 5 条（limit 缺省时 take=5）', async () => {
      const { service, repository } = makeContext();

      await service.findByFileUniqueId('UNIQ-1');

      expect(repository.find).toHaveBeenCalledWith({
        where: { fileUniqueId: 'UNIQ-1' },
        order: { createdAt: 'DESC' },
        take: 5,
      });
    });
  });

  describe('issue（fileUniqueId 落库）', () => {
    it('入参携带 fileUniqueId 时落库（群内认领归因的键）', async () => {
      const { service, repository } = makeContext();

      const { grant } = await service.issue(makeIssueInput({ fileUniqueId: 'UNIQ-1' }), 4);

      expect(repository.create).toHaveBeenCalledWith(expect.objectContaining({
        fileUniqueId: 'UNIQ-1',
        sourceAccountId: '1234567',
        telegramFileId: 'FILE-1',
      }));
      expect(repository.save).toHaveBeenCalled();
      expect(grant.id).toBe('grant-1');
    });

    it('缺省 fileUniqueId 时落库为 null（历史/降级路径向后兼容）', async () => {
      const { service, repository } = makeContext();

      await service.issue(makeIssueInput(), 4);

      expect(repository.create).toHaveBeenCalledWith(expect.objectContaining({ fileUniqueId: null }));
    });
  });
});
