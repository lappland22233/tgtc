import { BadRequestException } from '@nestjs/common';
import { GUARDS_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { ROLES_KEY } from '../common/decorators/roles.decorator';
import { UserRole } from '../common/entities/user.entity';
import { TelegramAccountsController } from './telegram-accounts.controller';

/**
 * 管理端点契约回归保护。
 *
 * 关键语义（改动前请先读这些断言）：
 * - **路由顺序**：Nest 按声明顺序匹配，字面量路径必须排在 `:id` 之前，
 *   否则 `replication-attempts` / `relay-preflight` 会被当成账号 id 吞掉
 *   （历史上 `env/:accountId/probe` 就是靠这条约束才没被吞）；
 * - **权限**：全部路由仅 SUPER_ADMIN + JwtAuthGuard/RolesGuard，不接受 API Key；
 * - **审计**：手动重试与预检必须留痕（谁在什么时候做了什么、结果如何）；
 * - **查询参数**：非法筛选值一律 400，不静默忽略（静默忽略会让「筛选了但看到全部」
 *   被误读成「该状态没有任何记录」）。
 */
describe('TelegramAccountsController（管理端点契约）', () => {
  const SUPER_ADMIN_USER = { id: 'admin-1', role: UserRole.SUPER_ADMIN } as never;
  /** 合法轮次 id（入口会做 UUID 校验，非 UUID 一律 400） */
  const ATTEMPT_ID = '11111111-1111-4111-8111-111111111111';

  function makeController(options: {
    report?: Record<string, unknown>;
    list?: Record<string, unknown>;
    detail?: Record<string, unknown>;
    retry?: Record<string, unknown>;
    preflight?: Record<string, unknown>;
  } = {}) {
    const auditLog = jest.fn();
    const replicationAudit = {
      getReport: jest.fn(async () => options.report ?? { strategy: {}, target: {} }),
      listAttempts: jest.fn(async () => options.list ?? {
        generatedAt: '2026-09-24T00:00:00.000Z',
        items: [],
        truncated: false,
        observability: { degraded: false, reason: null, since: null, writeFailures: 0 },
      }),
      getAttemptDetail: jest.fn(async () => options.detail ?? { id: 'att-1', retryable: true }),
      retryAttempt: jest.fn(async () => options.retry ?? {
        attemptId: 'att-2',
        status: 'partial_success',
        created: ['a2'],
        missing: ['a3'],
      }),
      runPreflight: jest.fn(async () => options.preflight ?? {
        dryRun: true,
        checkedAt: '2026-09-24T00:00:00.000Z',
        status: 'ok',
        checks: [],
        sentTestMessage: false,
        testMessageId: null,
        targetChatPreview: '***0222',
        sourceChatPreview: '***0111',
        notes: [],
      }),
    };
    const controller = new TelegramAccountsController(
      { list: jest.fn(), detail: jest.fn(), findById: jest.fn() } as never,
      {} as never,
      {} as never,
      { log: auditLog } as never,
      replicationAudit as never,
    );
    return { controller, replicationAudit, auditLog };
  }

  /** 取控制器原型上某个方法的路径元数据 */
  function routeOf(name: string): { path: string } {
    const handler = (TelegramAccountsController.prototype as unknown as Record<string, unknown>)[name] as object;
    return { path: Reflect.getMetadata(PATH_METADATA, handler) as string };
  }

  /** 控制器原型上所有带路径元数据的方法名（按声明顺序） */
  function declaredRouteNames(): string[] {
    return Object.getOwnPropertyNames(TelegramAccountsController.prototype)
      .filter((name) => name !== 'constructor'
        && Reflect.getMetadata(PATH_METADATA, (TelegramAccountsController.prototype as unknown as Record<string, unknown>)[name] as object) !== undefined);
  }

  it('扩散相关字面量路由必须声明在 :id 之前（否则会被当作账号 id 吞掉）', () => {
    const names = declaredRouteNames();
    const idIndex = names.indexOf('detail'); // @Get(':id')
    expect(idIndex).toBeGreaterThan(-1);
    for (const name of ['listReplicationAttempts', 'getReplicationAttempt', 'retryReplicationAttempt', 'relayPreflight']) {
      expect(names.indexOf(name)).toBeGreaterThan(-1);
      expect(names.indexOf(name)).toBeLessThan(idIndex);
    }
    expect(routeOf('listReplicationAttempts')).toMatchObject({ path: 'replication-attempts' });
    expect(routeOf('getReplicationAttempt')).toMatchObject({ path: 'replication-attempts/:attemptId' });
    expect(routeOf('retryReplicationAttempt')).toMatchObject({ path: 'replication-attempts/:attemptId/retry' });
    expect(routeOf('relayPreflight')).toMatchObject({ path: 'relay-preflight' });
  });

  it('全部扩散相关路由仅 SUPER_ADMIN，并挂载 JWT/Roles 守卫', () => {
    const guards = Reflect.getMetadata(GUARDS_METADATA, TelegramAccountsController) as unknown[];
    expect(guards).toHaveLength(2);

    for (const name of ['listReplicationAttempts', 'getReplicationAttempt', 'retryReplicationAttempt', 'relayPreflight']) {
      const handler = (TelegramAccountsController.prototype as unknown as Record<string, unknown>)[name] as object;
      expect(Reflect.getMetadata(ROLES_KEY, handler)).toEqual([UserRole.SUPER_ADMIN]);
    }
  });

  it('轮次列表把筛选条件透传，并拒绝非法取值（不静默忽略）', async () => {
    const ctx = makeController();

    await ctx.controller.listReplicationAttempts('claim_timeout', 'network', 'fileUnique', 'UNIQ-1', '3600000', '20');

    expect(ctx.replicationAudit.listAttempts).toHaveBeenCalledWith({
      status: 'claim_timeout',
      failureReason: 'network',
      ownerType: 'fileUnique',
      ownerId: 'UNIQ-1',
      sinceMs: 3_600_000,
      limit: 20,
    });

    await expect(ctx.controller.listReplicationAttempts('not-a-status')).rejects.toThrow(BadRequestException);
    await expect(ctx.controller.listReplicationAttempts(undefined, 'not-a-reason')).rejects.toThrow(BadRequestException);
    await expect(ctx.controller.listReplicationAttempts(undefined, undefined, 'grant2')).rejects.toThrow(BadRequestException);
    await expect(ctx.controller.listReplicationAttempts(undefined, undefined, undefined, undefined, '-5')).rejects.toThrow(BadRequestException);
    await expect(ctx.controller.listReplicationAttempts(undefined, undefined, undefined, undefined, undefined, '9999'))
      .rejects.toThrow('limit 不能超过 200');
  });

  it('空筛选值不下传（undefined 表示不筛选，而不是空字符串匹配）', async () => {
    const ctx = makeController();

    await ctx.controller.listReplicationAttempts('  ', '', undefined, '   ');

    expect(ctx.replicationAudit.listAttempts).toHaveBeenCalledWith({
      status: undefined,
      failureReason: undefined,
      ownerType: undefined,
      ownerId: undefined,
      sinceMs: undefined,
      limit: undefined,
    });
  });

  it('手动重试：写入审计并返回可读结果（只走中继，无策略选择项）', async () => {
    const ctx = makeController();

    const response = await ctx.controller.retryReplicationAttempt(SUPER_ADMIN_USER, ATTEMPT_ID);

    expect(ctx.replicationAudit.retryAttempt).toHaveBeenCalledWith(ATTEMPT_ID, 'admin-1');
    expect(response.message).toContain('新增 1 个 ready 副本');
    expect(ctx.auditLog).toHaveBeenCalledWith(expect.objectContaining({
      action: 'config_change',
      userId: 'admin-1',
      resourceType: 'telegram_replication_attempt',
      resourceId: ATTEMPT_ID,
      metadata: expect.objectContaining({ status: 'partial_success', newAttemptId: 'att-2', createdCount: 1 }),
    }));
  });

  it('手动重试无新增副本时也如实反馈（不粉饰成功）', async () => {
    const ctx = makeController({
      retry: { attemptId: 'att-2', status: 'claim_timeout', created: [], missing: ['a2'] },
    });

    const response = await ctx.controller.retryReplicationAttempt(SUPER_ADMIN_USER, ATTEMPT_ID);

    expect(response.message).toContain('未新增副本');
    expect(response.message).toContain('claim_timeout');
  });

  it('轮次 id 格式非法时入口 400（不把数据库方言错误变成观测降级）', async () => {
    const ctx = makeController();

    await expect(ctx.controller.getReplicationAttempt('att-1')).rejects.toThrow(BadRequestException);
    await expect(ctx.controller.retryReplicationAttempt(SUPER_ADMIN_USER, 'not-a-uuid'))
      .rejects.toThrow('扩散轮次 id 格式非法');
    // 入口就拦住，绝不能落到仓储层（PG 下非法 uuid 会抛 22P02 并污染观测降级标记）
    expect(ctx.replicationAudit.getAttemptDetail).not.toHaveBeenCalled();
    expect(ctx.replicationAudit.retryAttempt).not.toHaveBeenCalled();
  });

  it('预检默认 dry-run，且审计记录中只保留检查结论（不含 chat id 原文）', async () => {
    const ctx = makeController({
      preflight: {
        dryRun: true,
        checkedAt: '2026-09-24T00:00:00.000Z',
        status: 'partial',
        checks: [
          { id: 'config', label: '中继开关', status: 'ok', detail: 'ok' },
          { id: 'bots_can_receive', label: 'Bot 可接收', status: 'failed', detail: '隐私模式未关闭' },
        ],
        sentTestMessage: false,
        testMessageId: null,
        targetChatPreview: '***0222',
        sourceChatPreview: '***0111',
        notes: [],
      },
    });

    const report = await ctx.controller.relayPreflight(SUPER_ADMIN_USER, {});

    expect(ctx.replicationAudit.runPreflight).toHaveBeenCalledWith({
      dryRun: true,
      sourceChatId: undefined,
      targetChatId: undefined,
      testMessage: undefined,
    });
    expect(report.dryRun).toBe(true);
    expect(ctx.auditLog).toHaveBeenCalledWith(expect.objectContaining({
      resourceId: 'relay_preflight',
      metadata: expect.objectContaining({
        dryRun: true,
        status: 'partial',
        sentTestMessage: false,
        failedChecks: ['bots_can_receive'],
      }),
    }));
    // 审计 metadata 里不得出现完整 chat id
    const metadata = (ctx.auditLog.mock.calls[0][0] as { metadata: Record<string, unknown> }).metadata;
    expect(JSON.stringify(metadata)).not.toContain('-100222');
  });

  it('显式 dryRun=false 才允许发送测试消息（并把该事实写进审计）', async () => {
    const ctx = makeController({
      preflight: {
        dryRun: false,
        checkedAt: '2026-09-24T00:00:00.000Z',
        status: 'ok',
        checks: [{ id: 'target_chat_writable', label: '目标群可写', status: 'ok', detail: '已发送' }],
        sentTestMessage: true,
        testMessageId: null,
        targetChatPreview: '***0222',
        sourceChatPreview: '***0111',
        notes: [],
      },
    });

    const report = await ctx.controller.relayPreflight(SUPER_ADMIN_USER, {
      dryRun: false,
      testMessage: '预检',
    });

    expect(ctx.replicationAudit.runPreflight).toHaveBeenCalledWith(expect.objectContaining({ dryRun: false }));
    expect(report.sentTestMessage).toBe(true);
    expect(ctx.auditLog).toHaveBeenCalledWith(expect.objectContaining({
      metadata: expect.objectContaining({ sentTestMessage: true }),
    }));
  });
});
