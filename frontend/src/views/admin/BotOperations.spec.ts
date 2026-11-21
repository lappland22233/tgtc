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
const base = '/admin/bot-operations';
const id = '123456789012345678';
const now = '2026-11-21T12:00:00Z';
const task = { id:'task-a', telegramUserId:id, receiverBotId:'42', telegramUsername:'sample', telegramDisplayName:null, fileName:'photo.jpg', fileSize:'1024', status:'running', position:1, createdAt:now, updatedAt:now, startedAt:now, finishedAt:null, grantId:null, failureReason:null };
const grant = { ...task, id:'grant-a', status:'active', sourceAccountId:null, storageBackend:'gdrive', expiresAt:now, revokedAt:null, revokedBy:null, accessCount:3, tokenPrefix:'prefix' };
const user = { telegramUserId:id, ban:null, quota:{used:3, limit:null, remaining:null, usageDate:'2026-11-21', whitelisted:true}, downloads:{requests:5, bytes:'2048'}, uploads:{total:6,byStatus:{queued:1,running:1,completed:2,failed:1,cancelled:1}}, grants:{total:5, active:2} };
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
  http.get.mockImplementation(async path => {
    if (path === base + '/queue') return page([task]);
    if (path === base + '/grants') return page([grant]);
    if (path === base + '/users/' + id) return response(user);
    if (path.endsWith('/audit')) return page([{id:'event', action:'telegram_bot_user_banned', userId:'operator', resourceId:id, metadata:{reason:'confirmed reason', secret:'do-not-render'}, createdAt:now,status:'success'}]);
    throw new Error('Unexpected GET ' + path);
  });
  http.post.mockResolvedValue(response({changed:true}));
});
afterEach(() => { wrapper?.unmount(); });

describe('Bot 收件管理', () => {
  it('requires super-admin navigation access and sends accurate numeric IDs and local time filters', async () => {
    expect(hasAnyRole('super_admin', PAGE_ROLES[base])).toBe(true);
    expect(hasAnyRole('admin', PAGE_ROLES[base])).toBe(false);
    expect(hasAnyRole('user', PAGE_ROLES[base])).toBe(false);
    await visit();
    expect(wrapper.text()).toContain('photo.jpg');
    expect(wrapper.text()).toContain('该 Bot 队列顺位');
    await input('收件 Bot ID').setValue('42');
    await input('TG 用户 ID').setValue(id);
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

  it('ignores outdated responses, paginates, and confirms a task cancellation only once', async () => {
    const stale = deferred<unknown>();
    http.get.mockReturnValueOnce(stale.promise).mockResolvedValueOnce(page([task],21));
    await visit();
    const staleSignal = http.get.mock.calls[0][1]?.signal;
    await button('刷新').trigger('click');
    await flushPromises();
    expect(staleSignal?.aborted).toBe(true);
    stale.resolve(page([{...task,fileName:'stale-file'}]));
    await flushPromises();
    expect(wrapper.text()).not.toContain('stale-file');
    http.get.mockResolvedValueOnce(page([task],21));
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
    expect(http.get.mock.lastCall?.[1]?.params?.page).toBe(1);
  });

  it('defaults to active grants, recovers a link only on demand and clears it on refresh or revocation', async () => {
    await visit('?tab=grants');
    expect(http.get.mock.lastCall?.[1]?.params?.status).toBe('active');
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
    http.get.mockResolvedValueOnce(page([]));
    await button('确认撤销直链').trigger('click');
    await flushPromises();
    expect(http.post).toHaveBeenCalledExactlyOnceWith(base + '/grants/grant-a/revoke');
    expect(wrapper.text()).toContain('没有符合条件的记录');
  });

  it('opens a specific user from the queue, shows all grant history and safe audit fields, and bans with a reason', async () => {
    await visit();
    await wrapper.get('article a').trigger('click');
    await flushPromises();
    expect(http.get).toHaveBeenCalledWith(base + '/users/' + id, expect.anything());
    expect(http.get).toHaveBeenCalledWith(base + '/queue', expect.objectContaining({params:expect.objectContaining({telegramUserId:id})}));
    expect(wrapper.text()).toContain('白名单');
    await button('直链历史').trigger('click');
    await flushPromises();
    expect(http.get.mock.lastCall?.[1]?.params).toMatchObject({telegramUserId:id, status:'all'});
    await button('操作审计').trigger('click');
    await flushPromises();
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

  it('accepts a deep link and clears the prior user when navigating to another account', async () => {
    const old = deferred<unknown>();
    http.get.mockImplementation(async path => path.endsWith('/users/' + id) ? old.promise : path.endsWith('/users/77') ? response({...user, telegramUserId:'77'}) : page([]));
    await visit('?tab=user&telegramUserId=' + id);
    await input('TG 用户 ID').setValue('77');
    await wrapper.get('form').trigger('submit');
    await flushPromises();
    old.resolve(response({...user, ban:{reason:'old private reason'}}));
    await flushPromises();
    expect(wrapper.text()).toContain('TG 用户 77');
    expect(wrapper.text()).not.toContain('old private reason');
    expect(http.get).toHaveBeenCalledWith(base + '/queue', expect.objectContaining({params:expect.objectContaining({telegramUserId:'77'})}));
  });
});
