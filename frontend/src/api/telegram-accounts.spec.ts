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

import {
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
  pauseMirrorBackfill,
  resumeMirrorBackfill,
  retryMirrorTask,
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
    expect(result).toEqual({ items: [{ id: 'a1' }], total: 3 });
  });

  it('fetchAccounts 响应缺失字段时回退为空列表与 0', async () => {
    get.mockResolvedValue(respond(undefined));

    const result = await fetchAccounts();

    expect(get).toHaveBeenCalledWith('/admin/telegram-accounts', { params: {}, signal: undefined });
    expect(result).toEqual({ items: [], total: 0 });
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
});
