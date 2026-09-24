import { TelegramBotGrantService } from './telegram-bot-grant.service';
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
    findOne: jest.fn(async () => null),
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
    ...overrides,
  };
}

describe('TelegramBotGrantService（grant 内容标识与归因查询）', () => {
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
