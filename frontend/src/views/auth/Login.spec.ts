// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { mount } from '@vue/test-utils';
import { nextTick } from 'vue';

/**
 * B-14：登录页此前零组件测试。
 *
 * 最关键的安全不变量是 **redirect 查询参数必须过 isValidRedirect**，
 * 否则登录后可被诱导跳转到站外地址（开放重定向 / 凭据钓鱼）。
 * 另需保证失败时 loading 复位，否则按钮永久卡在「登录中…」。
 */

const push = vi.fn();
const login = vi.fn();
let query: Record<string, unknown> = {};

vi.mock('vue-router', () => ({
  useRouter: () => ({ push }),
  useRoute: () => ({ get query() { return query; } }),
}));
vi.mock('@/utils/message', () => ({
  default: { success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn() },
}));
vi.mock('../../stores/auth', () => ({
  useAuthStore: () => ({ login }),
}));
vi.mock('../../router', () => ({
  // 与真实实现同口径：只允许站内相对路径，拒绝协议相对与绝对外链
  isValidRedirect: (value: string) =>
    typeof value === 'string' && value.startsWith('/') && !value.startsWith('//'),
}));
vi.mock('./AuthGate.vue', () => ({
  default: { name: 'AuthGate', template: '<div><slot /><slot name="footer" /></div>' },
}));

import Login from './Login.vue';
import MessagePlugin from '@/utils/message';

function mountLogin() {
  return mount(Login, {
    global: {
      stubs: {
        't-form': {
          name: 'TForm',
          template: '<form @submit.prevent="$emit(\'submit\')"><slot /></form>',
          methods: { validate: () => Promise.resolve(true) },
        },
        't-form-item': { template: '<div><slot /></div>' },
        't-input': { template: '<input />', props: ['modelValue'], emits: ['update:modelValue'] },
        't-button': { template: '<button type="submit"><slot /></button>', props: ['loading'] },
        'router-link': { template: '<a><slot /></a>' },
      },
    },
  });
}

/** 直接触发组件内部的提交流程（表单 stub 的 validate 恒为 true） */
async function submit(wrapper: ReturnType<typeof mountLogin>) {
  await wrapper.find('form').trigger('submit');
  await nextTick();
  await Promise.resolve();
  await nextTick();
}

describe('Login.vue（B-14）', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    query = {};
    login.mockResolvedValue(undefined);
  });

  it('登录成功后默认跳转首页', async () => {
    const wrapper = mountLogin();
    await submit(wrapper);
    expect(login).toHaveBeenCalled();
    expect(push).toHaveBeenCalledWith('/');
    expect(MessagePlugin.success).toHaveBeenCalledWith('登录成功');
  });

  it('合法站内 redirect 被采纳', async () => {
    query = { redirect: '/files?folder=abc' };
    const wrapper = mountLogin();
    await submit(wrapper);
    expect(push).toHaveBeenCalledWith('/files?folder=abc');
  });

  it.each([
    ['绝对外链', 'https://evil.example.com'],
    ['协议相对外链', '//evil.example.com'],
    ['javascript 伪协议', 'javascript:alert(1)'],
    ['非字符串', ''],
  ])('不安全 redirect（%s）不得跳转，回落首页', async (_label, redirect) => {
    query = { redirect };
    const wrapper = mountLogin();
    await submit(wrapper);
    expect(push).toHaveBeenCalledWith('/');
    expect(push).not.toHaveBeenCalledWith(redirect);
  });

  it('登录失败时提示错误且 loading 复位，不跳转', async () => {
    login.mockRejectedValue(new Error('密码错误'));
    const wrapper = mountLogin();
    await submit(wrapper);

    expect(MessagePlugin.error).toHaveBeenCalled();
    expect(push).not.toHaveBeenCalled();
    const button = wrapper.find('button');
    expect(button.text()).toContain('登录');
    expect(button.text()).not.toContain('登录中');
  });

  it('提交过程中 loading 置位，结束后复位', async () => {
    let release!: () => void;
    login.mockImplementation(() => new Promise<void>((resolve) => { release = resolve; }));
    const wrapper = mountLogin();

    await wrapper.find('form').trigger('submit');
    await nextTick();
    expect(wrapper.find('button').text()).toContain('登录中');

    release();
    await Promise.resolve();
    await nextTick();
    expect(wrapper.find('button').text()).not.toContain('登录中');
  });
});