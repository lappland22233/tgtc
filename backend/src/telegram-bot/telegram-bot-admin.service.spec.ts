import { TelegramBotAdminService } from './telegram-bot-admin.service';

function makeService(
  envValues: Record<string, string | undefined> = {},
  dataSource: unknown = {},
) {
  const configService = { get: jest.fn((key: string) => envValues[key]) };
  const auditService = { log: jest.fn() };
  const grantService = {
    tokenPrefixOf: (token: string) => `tgl_${token.slice(0, 8)}`,
    findByToken: jest.fn(),
    revoke: jest.fn(),
    isActive: jest.fn(),
    listActiveByUser: jest.fn(async () => [] as Array<Record<string, unknown>>),
    replayToken: jest.fn(),
    buildUrl: jest.fn((origin: string, token: string) => `${origin}/api/bot-dl/${token}`),
  };
  const quotaService = {} as never;
  const configServiceForDomain = { resolveSiteOriginAsync: jest.fn(async () => 'https://example.com') };
  const service = new TelegramBotAdminService(
    configService as never,
    auditService as never,
    grantService as never,
    quotaService,
    configServiceForDomain as never,
    dataSource as never,
  );
  return { service, auditService, grantService, configServiceForDomain };
}

describe('TelegramBotAdminService', () => {
  it('管理员集合仅接受纯数字 TG 用户 ID（username 不参与权限判定）', () => {
    const { service } = makeService({ TELEGRAM_BOT_ADMIN_IDS: '111, 222,abc, @someone, ' });
    expect(service.isAdmin('111')).toBe(true);
    expect(service.isAdmin('222')).toBe(true);
    expect(service.isAdmin('abc')).toBe(false);
    expect(service.isAdmin('@someone')).toBe(false);
    expect(service.isAdmin('333')).toBe(false);
  });

  it('从完整直链或裸 Token 中提取 Token，非法输入返回 null', () => {
    const { service } = makeService({});
    const token = 'A'.repeat(43);
    expect(service.extractToken(`https://example.com/api/bot-dl/${token}`)).toBe(token);
    expect(service.extractToken(token)).toBe(token);
    expect(service.extractToken('https://example.com/api/bot-dl/')).toBeNull();
    expect(service.extractToken('short')).toBeNull();
    expect(service.extractToken('')).toBeNull();
    expect(service.extractToken('not-a-url/@@@')).toBeNull();
  });

  it('越权调用管理命令写入审计（含命令名，不含敏感内容）', () => {
    const { service, auditService } = makeService({});
    service.auditCommandDenied(
      { telegramUserId: '999', username: '@x', displayName: 'X' },
      '/link_query',
      'private',
    );
    expect(auditService.log).toHaveBeenCalledWith(expect.objectContaining({
      action: 'telegram_bot_command_denied',
      resourceId: '/link_query',
      status: 'failure',
    }));
  });

  it('/link_query 审计只记录命中条数，不记录完整链接', async () => {
    const { service, auditService, grantService } = makeService({});
    grantService.listActiveByUser.mockResolvedValue([
      {
        id: 'g1',
        tokenPrefix: 'tgl_abcdefgh',
        fileName: 'a.bin',
        expiresAt: new Date(Date.now() + 3600_000),
        revokedAt: null,
      },
    ]);
    grantService.replayToken.mockReturnValue('T'.repeat(43));

    const results = await service.queryLinks(
      { telegramUserId: '111', username: '@admin', displayName: 'A' },
      '222',
    );
    expect(results).toHaveLength(1);
    expect(results[0].url).toBe(`https://example.com/api/bot-dl/${'T'.repeat(43)}`);

    const auditPayload = auditService.log.mock.calls[0][0];
    expect(auditPayload.action).toBe('telegram_bot_link_queried');
    expect(JSON.stringify(auditPayload)).not.toContain('T'.repeat(43));
    expect(auditPayload.metadata).toMatchObject({ targetTelegramUserId: '222', hitCount: 1, replayable: 1 });
  });

  it('未启用加密存储时查询返回前缀与空链接（降级提示）', async () => {
    const { service, grantService } = makeService({});
    grantService.listActiveByUser.mockResolvedValue([
      { id: 'g2', tokenPrefix: 'tgl_zzzzzzzz', fileName: null, expiresAt: new Date(Date.now() + 3600_000), revokedAt: null },
    ]);
    grantService.replayToken.mockReturnValue(null);
    const results = await service.queryLinks(
      { telegramUserId: '111', username: null, displayName: null },
      '222',
    );
    expect(results[0].url).toBeNull();
    expect(results[0].prefix).toBe('tgl_zzzzzzzz');
  });

  it('/link_revoke 审计只记录 grantId 与前缀', async () => {
    const { service, auditService, grantService } = makeService({});
    const token = 'B'.repeat(43);
    grantService.findByToken.mockResolvedValue({
      id: 'grant-1',
      tokenPrefix: 'tgl_bbbbbbbb',
      telegramUserId: '222',
      revokedAt: null,
    });
    grantService.revoke.mockResolvedValue(true);

    const result = await service.revokeByToken(
      { telegramUserId: '111', username: '@admin', displayName: null },
      `https://example.com/api/bot-dl/${token}`,
    );
    expect(result.ok).toBe(true);
    const auditPayload = auditService.log.mock.calls[0][0];
    expect(auditPayload.action).toBe('telegram_bot_link_revoked');
    expect(JSON.stringify(auditPayload)).not.toContain(token);
    expect(auditPayload.metadata.tokenPrefix).toBe('tgl_bbbbbbbb');
  });

  it('Bot 使用汇总同时给出请求/分段/完成/中断口径与收到文件，并按时间桶合并趋势', async () => {
    const queries: string[] = [];
    const dataSource = {
      query: jest.fn(async (sql: string) => {
        queries.push(sql);
        if (sql.includes('AS "filesReceived"')) return [{ filesReceived: 2, receivedBytes: '3072' }];
        if (sql.includes('AS "files"')) return [{ bucket: 'B', files: 1, fileBytes: '1024' }];
        if (sql.includes('AS "reason"')) return [{ reason: 'client_abort', count: 1 }];
        if (sql.includes('AS "uniqueUsers"')) {
          return [{
            requests: 5,
            uniqueUsers: 3,
            rangedRequests: 2,
            completedRequests: 4,
            abortedRequests: 1,
            totalBytes: '2048',
          }];
        }
        return [{ bucket: 'A', requests: 5, ranged: 2, completed: 4, aborted: 1, bytes: '2048' }];
      }),
    };
    const { service } = makeService({}, dataSource);

    const summary = await service.getUsageSummary('7d');

    expect(summary).toMatchObject({
      timeRange: '7d',
      // 旧字段是「请求数」的兼容别名，语义必须与 requests 一致
      downloads: 5,
      requests: 5,
      rangedRequests: 2,
      completedRequests: 4,
      abortedRequests: 1,
      uniqueUsers: 3,
      totalBytes: '2048',
      filesReceived: 2,
      receivedBytes: '3072',
    });
    expect(summary.abortedByReason).toEqual({ client_abort: 1 });
    // 收到文件侧独立查询 grants，不与 access_logs 混算
    expect(queries.some((sql) => sql.includes('"telegram_bot_file_grants"'))).toBe(true);
    // 趋势查询必须统计 206 分段数，否则「生产 0 次 206」无法被证实
    expect(queries.some((sql) => sql.includes('AS "ranged"'))).toBe(true);
    // 两个数据源的时间桶合并为一条趋势（含只有收到文件、没有请求的桶）
    expect(summary.trend.map((row) => row.bucket)).toEqual(['A', 'B']);
    expect(summary.trend[0]).toMatchObject({
      downloads: 5,
      requests: 5,
      ranged: 2,
      completed: 4,
      aborted: 1,
      bytes: '2048',
      files: 0,
      fileBytes: '0',
    });
    expect(summary.trend[1]).toMatchObject({ requests: 0, bytes: '0', files: 1, fileBytes: '1024' });
  });

  it('收到文件与请求落在同一时间桶时合并为同一行', async () => {
    const dataSource = {
      query: jest.fn(async (sql: string) => {
        if (sql.includes('AS "filesReceived"')) return [{ filesReceived: 1, receivedBytes: '1024' }];
        if (sql.includes('AS "files"')) return [{ bucket: '2026-09-16 10:00:00', files: 1, fileBytes: '1024' }];
        if (sql.includes('AS "reason"')) return [];
        if (sql.includes('AS "uniqueUsers"')) {
          return [{ requests: 1, uniqueUsers: 1, rangedRequests: 1, completedRequests: 1, abortedRequests: 0, totalBytes: '2048' }];
        }
        return [{ bucket: '2026-09-16 10:00:00', requests: 1, ranged: 1, completed: 1, aborted: 0, bytes: '2048' }];
      }),
    };
    const { service } = makeService({}, dataSource);

    const summary = await service.getUsageSummary('24h');

    expect(summary.trend).toHaveLength(1);
    expect(summary.trend[0]).toMatchObject({
      requests: 1,
      ranged: 1,
      completed: 1,
      aborted: 0,
      bytes: '2048',
      files: 1,
      fileBytes: '1024',
    });
    expect(summary.abortedByReason).toEqual({});
  });

  it('用户明细按 TG 用户 ID 聚合，直接返回 @用户名且不含昵称', async () => {
    const calls: { sql: string; params: unknown[] }[] = [];
    const dataSource = {
      query: jest.fn(async (sql: string, params: unknown[] = []) => {
        calls.push({ sql, params });
        if (sql.includes('COUNT(DISTINCT g."telegramUserId")')) return [{ total: '1' }];
        return [{
          telegramUserId: '80000000000000001',
          telegramUsername: '@qa',
          filesReceived: '2',
          receivedBytes: '2048',
          downloads: '7',
          lastReceivedAt: '2026-09-16T10:00:00.000Z',
          lastAccessedAt: null,
        }];
      }),
    };
    const { service } = makeService({}, dataSource);

    const result = await service.getUserBreakdown({});

    expect(result).toMatchObject({ total: 1, page: 1, pageSize: 20 });
    expect(result.rows[0]).toEqual({
      telegramUserId: '80000000000000001',
      telegramUsername: '@qa',
      filesReceived: 2,
      receivedBytes: '2048',
      downloads: 7,
      lastReceivedAt: '2026-09-16T10:00:00.000Z',
      lastAccessedAt: null,
    });
    // 明确不返回昵称（需求：只看用户 ID 与 @用户名）
    expect(Object.keys(result.rows[0])).not.toContain('telegramDisplayName');
    expect(calls[0].sql).toContain('GROUP BY g."telegramUserId"');
    // 取该用户最新一次非空的用户名快照
    expect(calls[0].sql).toContain('ORDER BY g2."createdAt" DESC');
    // 无筛选条件时占位符从 $1 开始，ID 与用户名共用 LIKE 参数
    expect(calls[0].sql).toContain('LIMIT $1 OFFSET $2');
    expect(calls[0].params).toEqual([20, 0]);
  });

  it('用户明细关键字转义通配符、大小写不敏感，并同时匹配 ID 与用户名', async () => {
    const calls: { sql: string; params: unknown[] }[] = [];
    const dataSource = {
      query: jest.fn(async (sql: string, params: unknown[] = []) => {
        calls.push({ sql, params });
        return sql.includes('AS "total"') ? [{ total: '0' }] : [];
      }),
    };
    const { service } = makeService({}, dataSource);

    await service.getUserBreakdown({ keyword: '  A_B% ', timeRange: '24h', page: 3, pageSize: 1000 });

    const { sql, params } = calls[0];
    expect(sql).toContain('g."createdAt" >= $1');
    expect(sql).toContain(`LOWER(g."telegramUsername") LIKE $3 ESCAPE '\\'`);
    expect(params[0]).toBeInstanceOf(Date);
    expect(params[1]).toBe('%a\\_b\\%%');
    expect(params[2]).toBe('%a\\_b\\%%');
    // pageSize 上限 100、page=3 → offset 200
    expect(params[3]).toBe(100);
    expect(params[4]).toBe(200);
    // 计数查询复用同一批筛选参数（不含分页参数）
    expect(calls[1].params).toEqual(params.slice(0, 3));
  });

  it('用户明细未知时间范围回退为不限时间，页大小夹紧到下限', async () => {
    const calls: { sql: string; params: unknown[] }[] = [];
    const dataSource = {
      query: jest.fn(async (sql: string, params: unknown[] = []) => {
        calls.push({ sql, params });
        return sql.includes('AS "total"') ? [{ total: '0' }] : [];
      }),
    };
    const { service } = makeService({}, dataSource);

    await service.getUserBreakdown({ timeRange: 'bogus', pageSize: 0, page: 0 });

    const { sql, params } = calls[0];
    expect(sql).toContain('WHERE 1=1');
    expect(sql).toContain('LIMIT $1 OFFSET $2');
    expect(params).toEqual([1, 0]);
  });
});
