// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';

vi.mock('vue-router', () => ({
  useRoute: () => ({ path: '/dashboard' }),
}));

// 阻断 tdesign 真实导入链（含组件内部样式 CSS）：SideNav 经自动导入引用 Button，
// api client 经 utils/message 引用 MessagePlugin
vi.mock('tdesign-vue-next', () => ({
  Button: {
    props: ['disabled', 'loading'],
    emits: ['click'],
    template: '<button class="t-button-stub"><slot /></button>',
  },
  DialogPlugin: { confirm: vi.fn(), alert: vi.fn(), info: vi.fn(), warning: vi.fn() },
}));

vi.mock('tdesign-vue-next/es/message', () => ({
  MessagePlugin: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() },
}));

import SideNav from './SideNav.vue';
import { usePublicConfigStore, DEFAULT_SITE_TITLE } from '../stores/public-config';

function mountSidenav() {
  return mount(SideNav, {
    props: {
      role: 'super_admin',
      email: 'admin@example.com',
      roleText: '超级管理员',
      avatarLetter: 'A',
    },
    global: {
      plugins: [setActivePinia(createPinia())],
      stubs: {
        'router-link': { props: ['to'], template: '<a><slot /></a>' },
      },
    },
  });
}

describe('SideNav 侧栏网站标题', () => {
  beforeEach(() => {
    document.title = DEFAULT_SITE_TITLE;
  });

  it('默认渲染默认标题，且浏览器标签同源', () => {
    const wrapper = mountSidenav();
    expect(wrapper.find('.sidebar-title').text()).toBe(DEFAULT_SITE_TITLE);
    expect(document.title).toBe(DEFAULT_SITE_TITLE);
  });

  it('store 标题更新后侧栏响应式同步（无需重新挂载）', async () => {
    const wrapper = mountSidenav();
    const store = usePublicConfigStore();

    store.setSiteTitle('运维知识库');
    await wrapper.vm.$nextTick();

    expect(wrapper.find('.sidebar-title').text()).toBe('运维知识库');
    expect(document.title).toBe('运维知识库');
  });

  it('长标题保留完整文本于 title 属性，HTML 字符按纯文本渲染', async () => {
    const wrapper = mountSidenav();
    const store = usePublicConfigStore();

    const longTitle = 'A'.repeat(200);
    store.setSiteTitle(longTitle);
    await wrapper.vm.$nextTick();

    const titleEl = wrapper.find('.sidebar-title');
    // 截断由 CSS（text-overflow）实现，DOM 文本必须是完整标题
    expect(titleEl.text()).toBe(longTitle);
    expect(titleEl.attributes('title')).toBe(longTitle);

    store.setSiteTitle('<b>脚本</b>&标题');
    await wrapper.vm.$nextTick();
    // 文本插值：不产生真实子元素
    expect(wrapper.find('.sidebar-title b').exists()).toBe(false);
    expect(wrapper.find('.sidebar-title').text()).toBe('<b>脚本</b>&标题');
  });
});
