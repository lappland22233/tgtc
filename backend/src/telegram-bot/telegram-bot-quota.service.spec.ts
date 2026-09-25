import { TelegramBotQuotaService } from './telegram-bot-quota.service';

/**
 * 按 PostgreSQL 的真实返回形状伪造数据源：
 * - `INSERT`（无 RETURNING）→ 纯 rows 数组
 * - `UPDATE ... RETURNING` → `[rows, affectedCount]` 元组（TypeORM PostgresQueryRunner 行为）
 *
 * 这样可在无 PG 实例的环境下复现「配额判定失效」缺陷：
 * 若 `databaseQuery` 未解包元组，`rows.length` 恒为 2，第 6 个文件仍会被放行。
 */
function createPgShapedContext() {
  const usage = new Map<string, number>();

  const query = jest.fn(async (sql: string, parameters: unknown[] = []) => {
    const keyOf = (telegramUserId: unknown, usageDate: unknown) => `${telegramUserId}|${usageDate}`;

    if (/^\s*INSERT INTO "telegram_bot_daily_usage"/i.test(sql)) {
      const key = keyOf(parameters[1], parameters[2]);
      if (!usage.has(key)) usage.set(key, 0);
      return []; // PG：INSERT ... ON CONFLICT DO NOTHING 无 RETURNING → []
    }

    if (/^\s*UPDATE "telegram_bot_daily_usage"/i.test(sql)) {
      const [telegramUserId, usageDate] = parameters as [string, string, number?];
      const key = keyOf(telegramUserId, usageDate);

      // refund：归还一次
      if (/"issuedCount" - 1/.test(sql)) {
        const current = usage.get(key) ?? 0;
        if (current > 0) usage.set(key, current - 1);
        return [[], 0] as [unknown[], number];
      }

      const limit = Number(parameters[2]);
      const current = usage.get(key) ?? 0;
      if (current < limit) {
        usage.set(key, current + 1);
        return [[{ issuedCount: current + 1 }], 1] as [unknown[], number];
      }
      return [[], 0] as [unknown[], number]; // 已达上限：0 行
    }

    throw new Error(`未预期的 SQL: ${sql}`);
  });

  const usageRepository = {
    findOne: jest.fn(async ({ where }: { where: { telegramUserId: string; usageDate: string } }) => {
      const key = `${where.telegramUserId}|${where.usageDate}`;
      return usage.has(key) ? { issuedCount: usage.get(key) } : null;
    }),
  };
  const whitelistRepository = { findOne: jest.fn(async () => null) };

  const service = new TelegramBotQuotaService(
    usageRepository as never,
    whitelistRepository as never,
    { query } as never,
  );

  return { service, query, usage };
}

describe('TelegramBotQuotaService（PostgreSQL 返回形状）', () => {
  it('达到每日上限后拒绝继续扣减（元组未被误判为「有返回行」）', async () => {
    const { service } = createPgShapedContext();
    const telegramUserId = '900000123';
    const usageDate = '2026-09-15';

    const results = [];
    for (let index = 0; index < 7; index += 1) {
      results.push(await service.consume(telegramUserId, usageDate, 5));
    }

    expect(results.filter((result) => result.allowed)).toHaveLength(5);
    expect(results.filter((result) => !result.allowed)).toHaveLength(2);
    // 被拒绝时 used 必须反映真实已用量，不能是元组长度
    expect(results[5]).toEqual({ allowed: false, used: 5 });
    expect(results[6]).toEqual({ allowed: false, used: 5 });
    expect(await service.getUsed(telegramUserId, usageDate)).toBe(5);
  });

  it('被拒绝时不消耗额度（后续仍保持 5）', async () => {
    const { service } = createPgShapedContext();
    const telegramUserId = '900000124';
    const usageDate = '2026-09-15';

    await Promise.all(Array.from({ length: 5 }, () => service.consume(telegramUserId, usageDate, 5)));
    const denied = await service.consume(telegramUserId, usageDate, 5);
    expect(denied).toEqual({ allowed: false, used: 5 });
    expect(await service.getUsed(telegramUserId, usageDate)).toBe(5);
  });

  it('refund 归还一次额度', async () => {
    const { service } = createPgShapedContext();
    const telegramUserId = '900000125';
    const usageDate = '2026-09-15';

    await service.consume(telegramUserId, usageDate, 5);
    await service.consume(telegramUserId, usageDate, 5);
    expect(await service.getUsed(telegramUserId, usageDate)).toBe(2);

    await service.refund(telegramUserId, usageDate);
    expect(await service.getUsed(telegramUserId, usageDate)).toBe(1);
    // 归还可重新被使用
    await expect(service.consume(telegramUserId, usageDate, 2)).resolves.toEqual({ allowed: true, used: 2 });
  });

  it('limit=1 时第 2 次即被拒绝（边界）', async () => {
    const { service } = createPgShapedContext();
    const telegramUserId = '900000126';
    const usageDate = '2026-09-15';

    await expect(service.consume(telegramUserId, usageDate, 1)).resolves.toEqual({ allowed: true, used: 1 });
    await expect(service.consume(telegramUserId, usageDate, 1)).resolves.toEqual({ allowed: false, used: 1 });
  });

  it('不同业务日期互不影响（切日重置）', async () => {
    const { service } = createPgShapedContext();
    const telegramUserId = '900000127';

    await service.consume(telegramUserId, '2026-09-15', 1);
    await expect(service.consume(telegramUserId, '2026-09-15', 1)).resolves.toMatchObject({ allowed: false });
    await expect(service.consume(telegramUserId, '2026-09-16', 1)).resolves.toEqual({ allowed: true, used: 1 });
  });
});
