import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * 覆盖 `telegram-accounts.ts` 全部请求函数的 URL / 参数 / 响应解包。
 * 只 mock `./client`，验证契约与后端控制器前端一致（含 `response.data.data` 解包）。
 */

const get = vi.fn();
const post = vi.fn();
const put = vi.fn();
const patch = vi.fn();
const del = vi.fn();

vi.mock('./client', () => ({
  default: {
    get: (...args: unknown[]) => get(...args),
    post: (...args: unknown[]) => post(...args),
    put: (...args: unknown[]) => put(...args),
    patch: (...args: unknown[]) => patch(...args),
    delete: (...args: unknown[]) => del(...args),
  },
}));

import type {
  AccountPoolState,
  TelegramAccountRuntimeView,
  TelegramEnvAccountView,
} from './telegram-accounts';

import {
  RELAY_FAILURE_REASON_LABELS,
  cancelMirrorBackfill,
  cancelMirrorTask,
  cancelUserAuth,
  createBotAccount,
  createUserAccount,
  deleteAccount,
  fetchAccount,
  fetchAccountOverview,
  fetchAccounts,
  fetchMirrorBackfill,
  fetchMirrorOverview,
  fetchMirrorTasks,
  fetchReplicationAttemptDetail,
  fetchReplicationAttempts,
  fetchReplicationAudit,
  pauseMirrorBackfill,
  probeEnvAccount,
  resumeMirrorBackfill,
  retryMirrorTask,
  retryReplicationAttempt,
  runRelayPreflight,
  startMirrorBackfill,
  rotateAccount,
  setAccountPoolEnabled,
  setMirrorEnabled,
  setMirrorRuleEnabled,
  startUserAuth,
  testAccount,
  testMirrorRule,
  updateAccount,
  updateMirrorRule,
  updateReplicationTarget,
  verifyUserAuth,
} from './telegram-accounts';

/** 模拟全局 TransformInterceptor 包装：{ code, message, data } */
function respond(payload: unknown) {
  return { data: { code: 0, message: 'ok', data: payload } };
}

beforeEach(() => {
  get.mockReset();
  post.mockReset();
  put.mockReset();
  patch.mockReset();
  del.mockReset();
});

describe('账号池接口', () => {
  it('fetchAccountOverview 请求 overview 并解包', async () => {
    const payload = {
      feature: { accountPoolEnabled: true },
      counts: { total: 2 },
      precheck: [],
    };
    get.mockResolvedValue(respond(payload));

    const result = await fetchAccountOverview();

    expect(get).toHaveBeenCalledWith('/admin/telegram-accounts/overview', { signal: undefined });
    expect(result).toBe(payload);
  });

  it('fetchAccountOverview 透传 AbortSignal', async () => {
    const signal = new AbortController().signal;
    get.mockResolvedValue(respond({}));

    await fetchAccountOverview(signal);

    expect(get).toHaveBeenCalledWith('/admin/telegram-accounts/overview', { signal });
  });

  it('setAccountPoolEnabled 提交 feature 开关并解包 message/feature', async () => {
    const feature = { accountPoolEnabled: true };
    put.mockResolvedValue(respond({ message: '账号池已开启（仅影响新任务）', feature }));

    const result = await setAccountPoolEnabled(true);

    expect(put).toHaveBeenCalledWith('/admin/telegram-accounts/feature', { enabled: true });
    expect(result).toEqual({ message: '账号池已开启（仅影响新任务）', feature });
  });

  it('fetchAccounts 带上查询参数并归一化 items/total', async () => {
    get.mockResolvedValue(respond({ items: [{ id: 'a1' }], total: 3 }));

    const result = await fetchAccounts({ type: 'bot', status: 'active', page: 2, pageSize: 20 });

    expect(get).toHaveBeenCalledWith('/admin/telegram-accounts', {
      params: { type: 'bot', status: 'active', page: 2, pageSize: 20 },
      signal: undefined,
    });
    expect(result).toEqual({ items: [{ id: 'a1' }], total: 3, envAccounts: [] });
  });

  it('fetchAccounts 原样透传 includeRevoked（不传即排除已撤销）', async () => {
    get.mockResolvedValue(respond({ items: [], total: 0 }));

    await fetchAccounts({ type: 'bot', includeRevoked: true });

    expect(get).toHaveBeenCalledWith('/admin/telegram-accounts', {
      params: { type: 'bot', includeRevoked: true },
      signal: undefined,
    });
  });

  it('fetchAccounts 响应缺失字段时回退为空列表与 0', async () => {
    get.mockResolvedValue(respond(undefined));

    const result = await fetchAccounts();

    expect(get).toHaveBeenCalledWith('/admin/telegram-accounts', { params: {}, signal: undefined });
    expect(result).toEqual({ items: [], total: 0, envAccounts: [] });
  });

  it('createBotAccount 提交 bots 端点', async () => {
    post.mockResolvedValue(respond({ message: 'Bot 账号已添加', account: { id: 'b1' } }));

    const input = { name: 'bot-a', token: '123:abcdefghij', weight: 2 };
    const result = await createBotAccount(input);

    expect(post).toHaveBeenCalledWith('/admin/telegram-accounts/bots', input);
    expect(result).toEqual({ message: 'Bot 账号已添加', account: { id: 'b1' } });
  });

  it('createUserAccount 提交 users 端点', async () => {
    post.mockResolvedValue(respond({ message: '用户账号已创建，请完成交互式授权', account: { id: 'u1' } }));

    const input = { name: 'user-a', apiId: 12345, apiHash: 'hashhashhash' };
    const result = await createUserAccount(input);

    expect(post).toHaveBeenCalledWith('/admin/telegram-accounts/users', input);
    expect(result.account).toEqual({ id: 'u1' });
  });

  it('fetchAccount 按 id 请求详情', async () => {
    get.mockResolvedValue(respond({ id: 'a1', name: 'bot-a' }));

    const result = await fetchAccount('a1');

    expect(get).toHaveBeenCalledWith('/admin/telegram-accounts/a1', { signal: undefined });
    expect(result).toMatchObject({ id: 'a1' });
  });

  it('updateAccount 用 PATCH 提交变更', async () => {
    patch.mockResolvedValue(respond({ message: '账号已更新', account: { id: 'a1' } }));

    await updateAccount('a1', { enabled: false, weight: 5 });

    expect(patch).toHaveBeenCalledWith('/admin/telegram-accounts/a1', { enabled: false, weight: 5 });
  });

  it('deleteAccount 用 DELETE 撤销账号', async () => {
    del.mockResolvedValue(respond({ message: '账号已撤销', account: { id: 'a1' } }));

    const result = await deleteAccount('a1');

    expect(del).toHaveBeenCalledWith('/admin/telegram-accounts/a1');
    expect(result.message).toBe('账号已撤销');
  });

  it('testAccount 请求 test 子端点', async () => {
    post.mockResolvedValue(respond({ message: '测试完成', account: { id: 'a1' } }));

    await testAccount('a1');

    expect(post).toHaveBeenCalledWith('/admin/telegram-accounts/a1/test');
  });

  it('rotateAccount 提交 rotate 子端点与凭据载荷', async () => {
    post.mockResolvedValue(respond({ message: 'Bot 凭据已轮换', account: { id: 'a1' } }));

    await rotateAccount('a1', { token: '999:newsecrettoken' });

    expect(post).toHaveBeenCalledWith('/admin/telegram-accounts/a1/rotate', { token: '999:newsecrettoken' });
  });

  it('startUserAuth 请求 auth/start 并返回脱敏手机号', async () => {
    const payload = { phoneMasked: '+8***88', isCodeViaApp: true, expiresAt: '2026-09-22T10:00:00.000Z' };
    post.mockResolvedValue(respond(payload));

    const result = await startUserAuth('u1', { phoneNumber: '+8613800000000' });

    expect(post).toHaveBeenCalledWith('/admin/telegram-accounts/u1/auth/start', {
      phoneNumber: '+8613800000000',
    });
    expect(result).toBe(payload);
  });

  it('startUserAuth 未传参数时提交空对象', async () => {
    post.mockResolvedValue(respond({ phoneMasked: null, isCodeViaApp: false, expiresAt: '' }));

    await startUserAuth('u1');

    expect(post).toHaveBeenCalledWith('/admin/telegram-accounts/u1/auth/start', {});
  });

  it('verifyUserAuth 提交验证码与可选 2FA 密码', async () => {
    post.mockResolvedValue(respond({ ok: true, status: 'active' }));

    const result = await verifyUserAuth('u1', { code: '12345', password: 'secret' });

    expect(post).toHaveBeenCalledWith('/admin/telegram-accounts/u1/auth/verify', {
      code: '12345',
      password: 'secret',
    });
    expect(result).toEqual({ ok: true, status: 'active' });
  });

  it('cancelUserAuth 请求 auth/cancel', async () => {
    post.mockResolvedValue(respond({ ok: true }));

    const result = await cancelUserAuth('u1');

    expect(post).toHaveBeenCalledWith('/admin/telegram-accounts/u1/auth/cancel');
    expect(result).toEqual({ ok: true });
  });

  // ---------------- 环境变量主 Bot 只读展示（新契约） ----------------

  /** 完整 Token（仅用于断言脱敏：不得出现在任何返回视图中） */
  const FULL_TOKEN = '123456:AAFwxyzSECRETsecretTOKEN';

  const runtimeView: TelegramAccountRuntimeView = {
    inflight: 2,
    maxInflight: 8,
    bandwidthMbps: 12.5,
    successRate: 0.98,
    latencyMs: 120,
    coolingDown: false,
    cooldownRemainingMs: 0,
    consecutiveFailures: 0,
    totalRequests: 42,
    failures: 1,
    lastErrorKind: null,
    storageConfigured: true,
  };

  const envAccountView: TelegramEnvAccountView = {
    id: '123456',
    primary: true,
    source: 'env',
    readOnly: true,
    tokenPreview: '123456:AAF***',
    chatId: '-1001234567890',
    enabled: true,
    weight: 1,
    maxInflight: 8,
    note: null,
    runtime: runtimeView,
  };

  it('fetchAccountOverview 解析 pool 与 envAccounts 新字段', async () => {
    const pool: AccountPoolState = {
      enabled: true,
      inactiveReason: null,
      primaryAccountId: '123456',
      accountCount: 2,
      envAccountCount: 1,
    };
    const payload = {
      feature: { accountPoolEnabled: true },
      counts: { total: 2 },
      pool,
      envAccounts: [envAccountView],
      precheck: [
        { id: 'primary_bot', ok: true, hint: '环境变量主 Bot 已注册为只读账号' },
        { id: 'env_storage_chat', ok: false, hint: '环境变量账号未配置存储 Chat' },
      ],
    };
    get.mockResolvedValue(respond(payload));

    const result = await fetchAccountOverview();

    expect(get).toHaveBeenCalledWith('/admin/telegram-accounts/overview', { signal: undefined });
    expect(result.pool.primaryAccountId).toBe('123456');
    expect(result.pool.envAccountCount).toBe(1);
    expect(result.envAccounts).toHaveLength(1);
    expect(result.envAccounts[0].source).toBe('env');
    expect(result.envAccounts[0].readOnly).toBe(true);
    expect(result.envAccounts[0].runtime.storageConfigured).toBe(true);
    const precheckIds = result.precheck.map((item) => item.id);
    expect(precheckIds).toContain('primary_bot');
    expect(precheckIds).toContain('env_storage_chat');
  });

  it('fetchAccounts 解析 envAccounts 只读区（不占数据库分页）', async () => {
    get.mockResolvedValue(respond({ items: [{ id: 'a1' }], total: 1, envAccounts: [envAccountView] }));

    const result = await fetchAccounts({ type: 'bot' });

    expect(result.envAccounts).toHaveLength(1);
    expect(result.envAccounts[0].id).toBe('123456');
    expect(result.envAccounts[0].primary).toBe(true);
    expect(result.envAccounts[0].runtime.maxInflight).toBe(8);
    expect(result.envAccounts[0].runtime.inflight).toBe(2);
  });

  it('fetchAccounts 的账号项解析 source=both 与 runtime 运行态', async () => {
    get.mockResolvedValue(
      respond({ items: [{ id: 'a1', source: 'both', runtime: runtimeView }], total: 1 }),
    );

    const result = await fetchAccounts({ type: 'bot' });

    expect(result.items[0].source).toBe('both');
    expect(result.items[0].runtime?.inflight).toBe(2);
    expect(result.items[0].runtime?.lastErrorKind).toBeNull();
    expect(result.items[0].runtime?.storageConfigured).toBe(true);
  });

  it('fetchAccounts 在 type=user 时 envAccounts 恒为空数组', async () => {
    get.mockResolvedValue(respond({ items: [], total: 0, envAccounts: [] }));

    const result = await fetchAccounts({ type: 'user' });

    expect(get).toHaveBeenCalledWith('/admin/telegram-accounts', {
      params: { type: 'user' },
      signal: undefined,
    });
    expect(result.envAccounts).toEqual([]);
  });

  it('probeEnvAccount 用 POST 请求 env/:id/probe 并解包 message/probe', async () => {
    const probe = {
      ok: false,
      message: '环境变量账号探测失败',
      capabilities: { canUpload: false, supportsPolling: true },
      chatTitle: null,
      chatType: null,
      errorCode: 'probe_get_me_failed',
    };
    post.mockResolvedValue(respond({ message: probe.message, probe }));

    const result = await probeEnvAccount('123456');

    expect(post).toHaveBeenCalledWith('/admin/telegram-accounts/env/123456/probe');
    expect(result.message).toBe('环境变量账号探测失败');
    expect(result.probe.ok).toBe(false);
    expect(result.probe.errorCode).toBe('probe_get_me_failed');
  });

  it('环境变量账号 tokenPreview 已脱敏，响应中不含完整 Token', async () => {
    get.mockResolvedValue(respond({ items: [], total: 0, envAccounts: [envAccountView] }));

    const result = await fetchAccounts({ type: 'bot' });
    const serialized = JSON.stringify(result.envAccounts);

    expect(result.envAccounts[0].tokenPreview).toMatch(/^\d+:[A-Za-z0-9_-]{1,6}\*\*\*$/);
    expect(result.envAccounts[0].tokenPreview).toBe('123456:AAF***');
    expect(serialized).not.toContain(FULL_TOKEN);
    expect(serialized).not.toContain('AAFwxyzSECRETsecretTOKEN');
  });
});

describe('镜像接口', () => {
  it('fetchMirrorOverview 请求总览并透传 signal', async () => {
    const signal = new AbortController().signal;
    const payload = { rule: null, tasks: { queued: 0 }, precheck: [], notes: [] };
    get.mockResolvedValue(respond(payload));

    const result = await fetchMirrorOverview(signal);

    expect(get).toHaveBeenCalledWith('/admin/telegram-mirror', { signal });
    expect(result).toBe(payload);
  });

  it('updateMirrorRule 用 PUT 提交规则', async () => {
    put.mockResolvedValue(respond({ message: '镜像规则已更新', rule: { id: 'r1' } }));

    const input = { sourceChatId: '-100', targetChatId: '-200', mode: 'auto' as const };
    const result = await updateMirrorRule(input);

    expect(put).toHaveBeenCalledWith('/admin/telegram-mirror', input);
    expect(result.rule).toEqual({ id: 'r1' });
  });

  it('setMirrorEnabled 提交 feature 开关', async () => {
    put.mockResolvedValue(respond({ message: '镜像功能已开启' }));

    const result = await setMirrorEnabled(true);

    expect(put).toHaveBeenCalledWith('/admin/telegram-mirror/feature', { enabled: true });
    expect(result.message).toBe('镜像功能已开启');
  });

  it('setMirrorRuleEnabled 提交规则开关', async () => {
    put.mockResolvedValue(respond({ message: '镜像规则已启用', rule: { id: 'r1', enabled: true } }));

    await setMirrorRuleEnabled(true);

    expect(put).toHaveBeenCalledWith('/admin/telegram-mirror/rule/enabled', { enabled: true });
  });

  it('testMirrorRule 请求 test 端点并返回明细', async () => {
    const payload = {
      status: 'failed' as const,
      summary: '备份群不可用',
      details: [{ chat: 'target' as const, ok: false, title: null, type: null, error: 'no rights' }],
    };
    post.mockResolvedValue(respond(payload));

    const result = await testMirrorRule();

    expect(post).toHaveBeenCalledWith('/admin/telegram-mirror/test');
    expect(result).toBe(payload);
  });

  it('fetchMirrorTasks 带上筛选参数并归一化', async () => {
    get.mockResolvedValue(respond({ items: [{ id: 't1' }], total: 7 }));

    const result = await fetchMirrorTasks({ status: 'failed', ownerId: 'f1', page: 3, pageSize: 10 });

    expect(get).toHaveBeenCalledWith('/admin/telegram-mirror/tasks', {
      params: { status: 'failed', ownerId: 'f1', page: 3, pageSize: 10 },
      signal: undefined,
    });
    expect(result).toEqual({ items: [{ id: 't1' }], total: 7 });
  });

  it('fetchMirrorTasks 无参数时请求空参数对象', async () => {
    get.mockResolvedValue(respond({ items: [], total: 0 }));

    await fetchMirrorTasks();

    expect(get).toHaveBeenCalledWith('/admin/telegram-mirror/tasks', { params: {}, signal: undefined });
  });

  it('retryMirrorTask 请求 retry 子端点', async () => {
    post.mockResolvedValue(respond({ message: '任务已重新入队', task: { id: 't1', status: 'queued' } }));

    const result = await retryMirrorTask('t1');

    expect(post).toHaveBeenCalledWith('/admin/telegram-mirror/tasks/t1/retry');
    expect(result.task).toMatchObject({ id: 't1', status: 'queued' });
  });

  it('cancelMirrorTask 请求 cancel 子端点', async () => {
    post.mockResolvedValue(respond({ message: '任务已取消', task: { id: 't1', status: 'cancelled' } }));

    await cancelMirrorTask('t1');

    expect(post).toHaveBeenCalledWith('/admin/telegram-mirror/tasks/t1/cancel');
  });

  it('fetchMirrorBackfill 读取补偿状态并解包 job', async () => {
    get.mockResolvedValue(respond({
      job: { status: 'running', mode: 'apply', limit: 200, scanned: 40, queued: 12, skipped: 28, sample: ['f1'] },
    }));

    const job = await fetchMirrorBackfill();

    expect(get).toHaveBeenCalledWith('/admin/telegram-mirror/backfill', { signal: undefined });
    expect(job).toMatchObject({ status: 'running', queued: 12 });
  });

  it('startMirrorBackfill 提交 mode/limit（dry-run 只评估）', async () => {
    post.mockResolvedValue(respond({ message: '历史补偿评估已启动（仅统计，不入队）', job: { status: 'running' } }));

    const result = await startMirrorBackfill({ mode: 'dry-run', limit: 200 });

    expect(post).toHaveBeenCalledWith('/admin/telegram-mirror/backfill', { mode: 'dry-run', limit: 200 });
    expect(result.message).toContain('仅统计');
  });

  it('补偿控制端点：pause / resume / cancel', async () => {
    post.mockResolvedValue(respond({ message: 'ok', job: { status: 'paused' } }));

    await pauseMirrorBackfill();
    await resumeMirrorBackfill();
    await cancelMirrorBackfill();

    expect(post).toHaveBeenNthCalledWith(1, '/admin/telegram-mirror/backfill/pause');
    expect(post).toHaveBeenNthCalledWith(2, '/admin/telegram-mirror/backfill/resume');
    expect(post).toHaveBeenNthCalledWith(3, '/admin/telegram-mirror/backfill/cancel');
  });

  it('fetchReplicationAudit 读取副本资格审计报告并解包 data', async () => {
    get.mockResolvedValue(respond({
      generatedAt: '2026-09-24T00:00:00.000Z',
      target: { configured: 2, configuredSource: 'system', eligibleCount: 2, effectiveTarget: 2, degradedReason: null, allowedRange: { min: 1, max: 8 } },
      poolActive: true,
      accounts: [{ accountId: 'a1', readyCopies: 8, eligible: true, reasons: [] }],
      coverage: { scannedFiles: 10, satisfied: 8, unsatisfied: 2, truncated: false, missingSamples: [] },
      capacity: { enabled: true, currentBudget: 16, targetBudget: 16, activeBotCount: 2 },
      notes: ['USERbot 中继不计入 Bot ready 副本覆盖。'],
    }));

    const report = await fetchReplicationAudit();

    expect(get).toHaveBeenCalledWith('/admin/telegram-accounts/replication-audit', { signal: undefined });
    expect(report.target.effectiveTarget).toBe(2);
    expect(report.accounts[0]).toMatchObject({ accountId: 'a1', readyCopies: 8 });
  });

  it('updateReplicationTarget 以 PUT 提交期望副本数并返回目标解析', async () => {
    put.mockResolvedValue(respond({
      message: '期望副本数已更新为 3',
      target: { configured: 3, configuredSource: 'system', eligibleCount: 2, effectiveTarget: 2, degradedReason: '收敛', allowedRange: { min: 1, max: 8 } },
    }));

    const result = await updateReplicationTarget(3);

    expect(put).toHaveBeenCalledWith('/admin/telegram-accounts/replication-target', { desiredReplicas: 3 });
    expect(result.target).toMatchObject({ configured: 3, effectiveTarget: 2 });
  });

  it('fetchReplicationAudit 解析策略 B 观测面（strategy / relayMetrics / largeFileCoverage / recentAttempts）', async () => {
    get.mockResolvedValue(respond({
      generatedAt: '2026-09-24T00:00:00.000Z',
      strategy: {
        mode: 'user_relay_only',
        label: '仅用户账号中继',
        strategyARemoved: true,
        byteReplicationPossible: false,
        relayEnabledByConfig: true,
        restartRequiredForToggle: true,
        capability: {
          relayEnabledByConfig: true,
          userClientAvailable: true,
          userClientUnavailableReason: null,
          enabledAuthorizedUserCount: 1,
          resolvedTargetChatIdPreview: '***7890',
          sourceChatIdPreview: '***1234',
          sourceChatReadable: 'ok',
          targetChatWritable: 'not_checked',
          botsCanReceiveRelay: 'failed',
          checkedAt: '2026-09-24T01:00:00.000Z',
          checkStatus: 'partial',
          notes: [],
        },
      },
      relayMetrics: {
        windowMs: 86_400_000,
        since: '2026-09-23T00:00:00.000Z',
        attempts: 3,
        relaySucceeded: 2,
        relayFailed: 1,
        blocked: 0,
        succeeded: 1,
        partialSuccess: 0,
        claimTimeouts: 1,
        relaySuccessRate: null,
        claimRate: null,
        relayDurationP50Ms: null,
        relayDurationP95Ms: null,
        claimDurationP50Ms: null,
        claimDurationP95Ms: null,
        failureReasons: [{ reason: 'rate_limited', count: 1 }],
        bytesRelayed: 0,
        sampleSufficient: false,
        truncated: false,
      },
      largeFileCoverage: {
        ownerType: 'fileUnique',
        primary: null,
        secondary: null,
        scannedFiles: 0,
        truncated: false,
        readyAccounts: 1,
        schedulableAccounts: 1,
      },
      recentAttempts: [],
      observability: { degraded: false, reason: null, since: null, writeFailures: 0 },
      target: { configured: 2, configuredSource: 'system', eligibleCount: 2, effectiveTarget: 2, degradedReason: null, allowedRange: { min: 1, max: 8 } },
      poolActive: true,
      accounts: [],
      coverage: { scannedFiles: 0, satisfied: 0, unsatisfied: 0, truncated: false, missingSamples: [] },
      botCoverage: { scannedFiles: 0, satisfied: 0, unsatisfied: 0, truncated: false, missingSamples: [] },
      sizeCoverage: { scannedFiles: 0, truncated: false, tiers: [] },
      botSizeCoverage: { scannedFiles: 0, truncated: false, tiers: [] },
      capacity: null,
      notes: [],
    }));

    const report = await fetchReplicationAudit();

    expect(report.strategy.mode).toBe('user_relay_only');
    expect(report.strategy.strategyARemoved).toBe(true);
    expect(report.strategy.byteReplicationPossible).toBe(false);
    expect(report.strategy.capability.targetChatWritable).toBe('not_checked');
    expect(report.relayMetrics.bytesRelayed).toBe(0);
    // 低样本时比率必须为 null（界面据此显示「样本不足」而不是 0%）
    expect(report.relayMetrics.relaySuccessRate).toBeNull();
    expect(report.observability.degraded).toBe(false);
  });

  it('fetchReplicationAttempts 带上筛选参数并解包 items/truncated/observability', async () => {
    get.mockResolvedValue(respond({
      generatedAt: '2026-09-24T00:00:00.000Z',
      items: [{ id: 'att-1', status: 'claim_timeout', retryable: true }],
      truncated: true,
      observability: { degraded: true, reason: '写入失败', since: null, writeFailures: 1 },
    }));

    const result = await fetchReplicationAttempts({ status: 'claim_timeout', limit: 20 });

    expect(get).toHaveBeenCalledWith('/admin/telegram-accounts/replication-attempts', {
      params: { status: 'claim_timeout', limit: 20 },
      signal: undefined,
    });
    expect(result.items[0]).toMatchObject({ id: 'att-1', retryable: true });
    expect(result.truncated).toBe(true);
    expect(result.observability.degraded).toBe(true);
  });

  it('fetchReplicationAttemptDetail 对 id 做 URL 编码', async () => {
    get.mockResolvedValue(respond({ id: 'att 1', retryable: true, timeline: [], why: '', impact: '', advice: '' }));

    await fetchReplicationAttemptDetail('att 1');

    expect(get).toHaveBeenCalledWith('/admin/telegram-accounts/replication-attempts/att%201', {
      signal: undefined,
    });
  });

  it('retryReplicationAttempt 请求 retry 子端点并返回策略 B 结果', async () => {
    post.mockResolvedValue(respond({
      message: '重试已提交',
      attemptId: 'att-2',
      status: 'partial_success',
      created: ['a1'],
      missing: ['a2'],
    }));

    const result = await retryReplicationAttempt('att-1');

    expect(post).toHaveBeenCalledWith('/admin/telegram-accounts/replication-attempts/att-1/retry');
    expect(result.status).toBe('partial_success');
    expect(result.created).toEqual(['a1']);
    expect(result.missing).toEqual(['a2']);
  });

  it('runRelayPreflight 默认提交 dryRun=true（不产生 Telegram 消息）', async () => {
    const report = {
      dryRun: true,
      checkedAt: '2026-09-24T03:00:00.000Z',
      status: 'partial' as const,
      checks: [{ id: 'config', label: '中继开关', status: 'ok' as const, detail: 'ok' }],
      sentTestMessage: false,
      testMessageId: null,
      targetChatPreview: '***7890',
      sourceChatPreview: null,
      notes: [],
    };
    post.mockResolvedValue(respond(report));

    const result = await runRelayPreflight();

    expect(post).toHaveBeenCalledWith('/admin/telegram-accounts/relay-preflight', {});
    expect(result).toBe(report);
    expect(result.sentTestMessage).toBe(false);
  });

  it('runRelayPreflight 显式 dryRun=false 时才允许发送测试消息', async () => {
    post.mockResolvedValue(respond({
      dryRun: false,
      checkedAt: '2026-09-24T03:00:00.000Z',
      status: 'ok',
      checks: [],
      sentTestMessage: true,
      testMessageId: null,
      targetChatPreview: '***7890',
      sourceChatPreview: null,
      notes: [],
    }));

    const result = await runRelayPreflight({ dryRun: false });

    expect(post).toHaveBeenCalledWith('/admin/telegram-accounts/relay-preflight', { dryRun: false });
    expect(result.sentTestMessage).toBe(true);
  });

  it('失败原因中文映射覆盖后端全部标准化键（避免出现英文键直出）', () => {
    const keys = [
      'not_configured',
      'client_unavailable',
      'no_account',
      'source_missing',
      'target_missing',
      'permission_denied',
      'auth_invalid',
      'rate_limited',
      'network',
      'unknown',
    ];
    for (const key of keys) {
      expect(RELAY_FAILURE_REASON_LABELS[key as keyof typeof RELAY_FAILURE_REASON_LABELS]).toBeTruthy();
    }
  });
});
