// @vitest-environment jsdom
import { defineComponent } from 'vue';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { createMemoryHistory, createRouter } from 'vue-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import BotOperations from './BotOperations.vue';
import { hasAnyRole, PAGE_ROLES } from '@/utils/permissions';

interface Options { params?: Record<string, unknown>; signal?: AbortSignal }
const http = vi.hoisted(() => ({
  get: vi.fn<(path: string, options?: Options) => Promise<unknown>>(),
  post: vi.fn<(path: string, body?: unknown) => Promise<unknown>>(),
}));
vi.mock('@/api/client', () => ({ default: http }));
const charts = vi.hoisted(() => ({ options: [] as unknown[] }));
vi.mock('@/utils/echarts', () => ({
  init: () => ({
    setOption: (option: unknown) => { charts.options.push(option); },
    resize: vi.fn(),
    dispose: vi.fn(),
  }),
}));
vi.mock('@/utils/echarts-theme', () => ({
  CHART_COLORS: { primary: '#000', success: '#000', warning: '#000', danger: '#000', slate: '#000' },
  CHART_COLORS_DARK: { primary: '#000', success: '#000', warning: '#000', danger: '#000', slate: '#000' },
  tooltipBase: {},
  legendBase: {},
  ensureCyberTheme: vi.fn(async () => undefined),
}));
const base = '/admin/bot-operations';
const id = '123456789012345678';
const now = '2026-11-21T12:00:00Z';
const overview = {
  timeRange: '7d', generatedAt: now,
  queue: { total: 6, byStatus: { queued: 1, running: 1, completed: 2, failed: 1, cancelled: 1 }, pending: 1, running: 1, bytes: '4096', successRate: 0.5 },
  grants: { total: 5, byStatus: { active: 2, expired: 2, revoked: 1 }, activeNow: 3, downloads: 9 },
  trend: [{ bucket: now, queued: 1, running: 1, completed: 2, failed: 1, cancelled: 1, total: 6 }],
  topBots: [{ receiverBotId: '42', total: 4, failed: 1, bytes: '2048' }],
};
const task = { id:'task-a', telegramUserId:id, receiverBotId:'42', telegramUsername:'sample', telegramDisplayName:null, fileName:'photo.jpg', fileSize:'1024', status:'running', position:1, createdAt:now, updatedAt:now, startedAt:now, finishedAt:null, grantId:null, failureReason:null };
const grant = { ...task, id:'grant-a', status:'active', sourceAccountId:null, storageBackend:'gdrive', expiresAt:now, revokedAt:null, revokedBy:null, accessCount:3, tokenPrefix:'prefix' };
const user = { telegramUserId:id, ban:null, quota:{used:3, limit:null, remaining:null, usageDate:'2026-11-21', whitelisted:true}, downloads:{requests:5, bytes:'2048'}, uploads:{total:6,byStatus:{queued:1,running:1,completed:2,failed:1,cancelled:1}}, grants:{total:5, active:2} };
const auditEvent = { id:'event', action:'telegram_bot_user_banned', userId:'operator', resourceId:id, metadata:{reason:'confirmed reason', secret:'do-not-render'}, createdAt:now, status:'success' };

function groupRow(scope: 'queue' | 'grants' | 'audit') {
  return {
    telegramUserId: id,
    telegramUsername: 'sample',
    total: scope === 'audit' ? 3 : 2,
    byStatus: scope === 'queue'
      ? { queued: 0, running: 0, completed: 1, failed: 1, cancelled: 0 }
      : scope === 'grants'
        ? { active: 1, expired: 1, revoked: 0 }
        : {},
    bytes: '2048',
    downloads: scope === 'grants' ? 3 : 0,
    lastAt: now,
  };
}

function response(payload: unknown) { return { data:{ data:payload } }; }
function page(rows: unknown[], total = rows.length) { return response({ rows, total, page:1, pageSize:20 }); }
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

let wrapper: VueWrapper;
async function visit(query = '') {
  const router = createRouter({
    history:createMemoryHistory(),
    routes:[{path:base, component:BotOperations}],
  });
  await router.push(base + query);
  await router.isReady();
  wrapper = mount(defineComponent({ template:'<router-view />' }), { global:{ plugins:[router] } });
  await flushPromises();
  return router;
}
function button(label: string) {
  const found = wrapper.findAll('button').find(element => element.text() === label);
  if (!found) throw new Error('Missing button ' + label);
  return found;
}
function input(label: string) {
  const field = wrapper.findAll('label').find(element => element.text().startsWith(label));
  if (!field) throw new Error('Missing field ' + label);
  return field.get('input,select,textarea');
}

beforeEach(() => {
  vi.resetAllMocks();
  charts.options.length = 0;
  http.get.mockImplementation(async (path, options) => {
    if (path === base + '/overview') return response(overview);
    if (path === base + '/user-groups') {
      const scope = String(options?.params?.scope ?? 'queue') as 'queue' | 'grants' | 'audit';
      return response({ scope, page: 1, pageSize: 20, total: 1, rows: [groupRow(scope)] });
    }
    if (path === base + '/queue') return page([task]);
    if (path === base + '/grants') return page([grant]);
    if (path === base + '/users/' + id) return response(user);
    if (path.endsWith('/audit')) return page([auditEvent]);
    throw new Error('Unexpected GET ' + path);
  });
  http.post.mockResolvedValue(response({changed:true}));
});
afterEach(() => { wrapper?.unmount(); });

describe('Bot 收件管理', () => {
  it('defaults to the chart dashboard and refetches when the time range changes', async () => {
    await visit();
    expect(http.get).toHaveBeenCalledWith(base + '/overview', expect.objectContaining({ params: { timeRange: '7d' } }));
    expect(wrapper.text()).toContain('收件任务');
    expect(wrapper.text()).toContain('50%');
    expect(wrapper.text()).toContain('有效直链');
    expect(wrapper.findAll('.ops-chart-canvas')).toHaveLength(4);
    expect(wrapper.text()).toContain('区间内共 6 个收件任务');
    expect(charts.options).toHaveLength(4);
    const trend = charts.options[0] as { series: { name: string; data: number[] }[] };
    expect(trend.series.map(series => series.name)).toEqual(['已完成', '失败', '已取消', '处理中', '待处理']);
    const lengths = new Set(trend.series.map(series => series.data.length));
    expect(lengths.size).toBe(1);
    const bars = trend.series[0].data.length;
    expect(bars).toBeGreaterThan(1);
    // 唯一有数据的桶之前应补成 0，而不是被直接合并到数据桶
    expect(trend.series[0].data.slice(0, -1).every(value => value === 0)).toBe(true);
    expect(trend.series[0].data[bars - 1]).toBe(2);
    expect(trend.series.map(series => series.data.reduce((sum, value) => sum + value, 0))).toEqual([2, 1, 1, 1, 1]);
    const bots = charts.options[3] as { series: { name: string; data: number[] }[] };
    expect(bots.series.map(series => series.data)).toEqual([[4], [1]]);
    await input('统计范围').setValue('30d');
    await flushPromises();
    expect(http.get.mock.lastCall?.[1]?.params).toMatchObject({ timeRange: '30d' });
  });

  it('classifies queue records by user and filters before entering the detail', async () => {
    expect(hasAnyRole('super_admin', PAGE_ROLES[base])).toBe(true);
    expect(hasAnyRole('admin', PAGE_ROLES[base])).toBe(false);
    expect(hasAnyRole('user', PAGE_ROLES[base])).toBe(false);
    await visit('?tab=queue');
    expect(http.get).toHaveBeenCalledWith(base + '/user-groups', expect.objectContaining({ params: expect.objectContaining({ scope: 'queue', page: 1, pageSize: 20 }) }));
    expect(wrapper.text()).toContain('收件用户');
    expect(wrapper.text()).toContain('@sample');
    expect(wrapper.text()).toContain('已完成 1');
    expect(wrapper.text()).toContain('查看详情');
    await input('搜索用户').setValue('sample');
    await input('时间范围').setValue('7d');
    await wrapper.get('form').trigger('submit');
    await flushPromises();
    expect(http.get.mock.lastCall?.[1]?.params).toMatchObject({ scope: 'queue', keyword: 'sample', page: 1 });
    expect(typeof http.get.mock.lastCall?.[1]?.params?.from).toBe('string');
    await wrapper.get('.ops-group-row').trigger('click');
    await flushPromises();
    expect(wrapper.text()).toContain('返回用户列表');
    expect(http.get).toHaveBeenCalledWith(base + '/queue', expect.objectContaining({ params: expect.objectContaining({ telegramUserId: id }) }));
  });

  it('requires super-admin navigation access and sends accurate numeric IDs and local time filters in user detail', async () => {
    await visit('?tab=queue&telegramUserId=' + id);
    expect(wrapper.text()).toContain('photo.jpg');
    expect(wrapper.text()).toContain('该 Bot 队列顺位');
    await input('收件 Bot ID').setValue('42');
    await input('状态').setValue('failed');
    await input('开始时间').setValue('2026-11-20T13:30');
    await input('结束时间').setValue('2026-11-21T13:30');
    await wrapper.get('form').trigger('submit');
    await flushPromises();
    expect(http.get).toHaveBeenLastCalledWith(base + '/queue', expect.objectContaining({params:{
      receiverBotId:'42', telegramUserId:id, status:'failed', page:1, pageSize:20,
      from:new Date('2026-11-20T13:30').toISOString(), to:new Date('2026-11-21T13:30').toISOString(),
    }}));
    const calls = http.get.mock.calls.length;
    await input('开始时间').setValue('2026-11-22T13:30');
    await wrapper.get('form').trigger('submit');
    expect(wrapper.get('[role="alert"]').text()).toContain('结束时间');
    expect(http.get).toHaveBeenCalledTimes(calls);
    await button('重置').trigger('click');
    await flushPromises();
    expect(http.get.mock.lastCall?.[1]?.params).toMatchObject({status:'all', page:1});
  });

  it('ignores outdated list responses, paginates, and confirms a task cancellation only once', async () => {
    await visit('?tab=queue&telegramUserId=' + id);
    expect(wrapper.text()).toContain('photo.jpg');
    const stale = deferred<unknown>();
    http.get.mockImplementation(async path => {
      if (path === base + '/users/' + id) return response(user);
      if (path === base + '/queue') return stale.promise;
      throw new Error('Unexpected GET ' + path);
    });
    await button('刷新').trigger('click');
    const staleSignal = http.get.mock.lastCall?.[1]?.signal;
    http.get.mockImplementation(async path => path === base + '/users/' + id ? response(user) : page([task],21));
    await button('刷新').trigger('click');
    await flushPromises();
    expect(staleSignal?.aborted).toBe(true);
    stale.resolve(page([{...task,fileName:'stale-file'}]));
    await flushPromises();
    expect(wrapper.text()).not.toContain('stale-file');
    expect(wrapper.text()).toContain('共 21 条');
    await button('下一页').trigger('click');
    await flushPromises();
    expect(http.get.mock.lastCall?.[1]?.params?.page).toBe(2);
    await button('取消任务').trigger('click');
    expect(http.post).not.toHaveBeenCalled();
    await button('返回').trigger('click');
    await button('取消任务').trigger('click');
    const mutation = deferred<unknown>();
    http.post.mockReturnValueOnce(mutation.promise);
    await button('确认取消任务').trigger('click');
    expect(button('确认取消任务').attributes('disabled')).toBeDefined();
    mutation.resolve(response({changed:true}));
    await flushPromises();
    expect(http.post).toHaveBeenCalledExactlyOnceWith(base + '/queue/task-a/cancel');
    expect(wrapper.text()).toContain('任务已取消');
    expect(http.get.mock.lastCall?.[1]?.params?.page).toBe(2);
  });

  it('groups grant records by user and recovers or revokes a link inside the user detail', async () => {
    await visit('?tab=grants');
    expect(http.get).toHaveBeenCalledWith(base + '/user-groups', expect.objectContaining({ params: expect.objectContaining({ scope: 'grants' }) }));
    expect(wrapper.text()).toContain('直链用户');
    expect(wrapper.text()).toContain('有效 1');
    await wrapper.get('.ops-group-row').trigger('click');
    await flushPromises();
    const grantsCall = http.get.mock.calls.find(([path, options]) => path === base + '/grants' && options?.params?.telegramUserId === id);
    expect(grantsCall?.[1]?.params).toMatchObject({ telegramUserId: id, status: 'all', page: 1, pageSize: 20 });
    const url = 'https://example.invalid/d/local-ticket';
    expect(wrapper.html()).not.toContain(url);
    http.get.mockResolvedValueOnce(response({url}));
    await button('查看直链').trigger('click');
    await flushPromises();
    expect((input('有效直链').element as HTMLInputElement).value).toBe(url);
    await button('收起').trigger('click');
    expect(wrapper.html()).not.toContain(url);
    http.get.mockResolvedValueOnce(response({url:null}));
    await button('查看直链').trigger('click');
    await flushPromises();
    expect(wrapper.text()).toContain('无法恢复完整直链');
    await button('撤销直链').trigger('click');
    expect(http.post).not.toHaveBeenCalled();
    http.get.mockImplementation(async path => path === base + '/users/' + id ? response(user) : page([]));
    await button('确认撤销直链').trigger('click');
    await flushPromises();
    expect(http.post).toHaveBeenCalledExactlyOnceWith(base + '/grants/grant-a/revoke');
    expect(wrapper.text()).toContain('没有符合条件的记录');
  });

  it('groups audit records by user and bans with a reason inside the user detail', async () => {
    await visit('?tab=user');
    expect(http.get).toHaveBeenCalledWith(base + '/user-groups', expect.objectContaining({ params: expect.objectContaining({ scope: 'audit' }) }));
    expect(wrapper.text()).toContain('审计用户');
    expect(wrapper.text()).toContain('3 次操作');
    await wrapper.get('.ops-group-row').trigger('click');
    await flushPromises();
    expect(http.get).toHaveBeenCalledWith(base + '/users/' + id + '/audit', expect.anything());
    expect(wrapper.text()).toContain('confirmed reason');
    expect(wrapper.text()).not.toContain('do-not-render');
    await button('封禁 TG 用户').trigger('click');
    expect(button('确认封禁').attributes('disabled')).toBeDefined();
    await input('封禁原因').setValue('  policy violation  ');
    http.post.mockResolvedValueOnce(response({cancelledTasks:2, revokedGrants:3}));
    http.get.mockImplementation(async path => path.endsWith('/audit') ? page([]) : response({...user, ban:{telegramUserId:id, reason:'policy violation', bannedBy:'operator', bannedAt:now}}));
    await wrapper.get('.ops-confirm').trigger('submit');
    await flushPromises();
    expect(http.post).toHaveBeenCalledExactlyOnceWith(base + '/users/' + id + '/ban', {reason:'policy violation'});
    expect(wrapper.text()).toContain('取消 2 项任务并撤销 3 条直链');
    expect(wrapper.text()).toContain('policy violation');
    expect(wrapper.find('textarea').exists()).toBe(false);
  });

  it('follows user deep links and ignores responses from the previous user', async () => {
    const old = deferred<unknown>();
    http.get.mockImplementation(async path => {
      if (path === base + '/users/' + id) return old.promise;
      if (path === base + '/users/77') return response({...user, telegramUserId:'77'});
      if (path.endsWith('/audit')) return page([]);
      throw new Error('Unexpected GET ' + path);
    });
    const router = await visit('?tab=user&telegramUserId=' + id);
    await router.push('/admin/bot-operations?tab=user&telegramUserId=77');
    await flushPromises();
    old.resolve(response({...user, ban:{reason:'old private reason'}}));
    await flushPromises();
    expect(wrapper.text()).toContain('TG 用户 77');
    expect(wrapper.text()).not.toContain('old private reason');
  });
});
