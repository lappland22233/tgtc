// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import type { UserRole } from '../types/user';

vi.mock('vue-router', () => ({
  useRoute: () => ({ path: '/dashboard' }),
}));

vi.mock('tdesign-vue-next/es/message', () => ({
  MessagePlugin: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() },
}));

import SideNav from './SideNav.vue';
import { usePublicConfigStore, DEFAULT_SITE_TITLE } from '../stores/public-config';

function mountSidenav(role: UserRole = 'super_admin') {
  return mount(SideNav, {
    props: {
      role,
      email: 'admin@example.com',
      roleText: '超级管理员',
      avatarLetter: 'A',
    },
    global: {
      plugins: [setActivePinia(createPinia())],
      stubs: {
        'router-link': { props: ['to'], template: '<a :href="to"><slot /></a>' },
        't-icon': true,
      },
    },
  });
}

describe('工作台导航网站标题', () => {
  beforeEach(() => {
    document.title = DEFAULT_SITE_TITLE;
  });

  it('默认渲染默认标题，且浏览器标签同源', () => {
    const wrapper = mountSidenav();
    expect(wrapper.find('.workspace-brand-title').text()).toBe(DEFAULT_SITE_TITLE);
    expect(document.title).toBe(DEFAULT_SITE_TITLE);
  });

  it('store 标题更新后工作台导航响应式同步（无需重新挂载）', async () => {
    const wrapper = mountSidenav();
    const store = usePublicConfigStore();

    store.setSiteTitle('运维知识库');
    await wrapper.vm.$nextTick();

    expect(wrapper.find('.workspace-brand-title').text()).toBe('运维知识库');
    expect(document.title).toBe('运维知识库');
  });

  it('长标题保留完整文本于 title 属性，HTML 字符按纯文本渲染', async () => {
    const wrapper = mountSidenav();
    const store = usePublicConfigStore();

    const longTitle = 'A'.repeat(200);
    store.setSiteTitle(longTitle);
    await wrapper.vm.$nextTick();

    const titleEl = wrapper.find('.workspace-brand-title');
    // 截断由 CSS（text-overflow）实现，DOM 文本必须是完整标题
    expect(titleEl.text()).toBe(longTitle);
    expect(titleEl.attributes('title')).toBe(longTitle);

    store.setSiteTitle('<b>脚本</b>&标题');
    await wrapper.vm.$nextTick();
    // 文本插值：不产生真实子元素
    expect(wrapper.find('.workspace-brand-title b').exists()).toBe(false);
    expect(wrapper.find('.workspace-brand-title').text()).toBe('<b>脚本</b>&标题');
  });
});

describe('工作台导航权限', () => {
  it('保留三个常用入口和个人设置，管理链接由角色决定', async () => {
    const wrapper = mountSidenav('user');
    expect(wrapper.findAll('.workspace-tab').map((tab) => tab.attributes('href')))
      .toEqual(['/files', '/shares', '/dashboard']);
    expect(wrapper.find('a[href="/settings"]').exists()).toBe(true);
    expect(wrapper.find('.workspace-admin-nav').exists()).toBe(false);

    await wrapper.setProps({ role: 'admin' });
    expect(wrapper.findAll('.workspace-admin-nav a').map((link) => link.attributes('href')))
      .toEqual(['/admin', '/admin/users', '/admin/files']);
    expect(wrapper.find('a[href="/admin/config"]').exists()).toBe(false);

    await wrapper.setProps({ role: 'super_admin' });
    expect(wrapper.find('a[href="/admin/config"]').exists()).toBe(true);
    expect(wrapper.find('a[href="/admin/storage-backends"]').exists()).toBe(true);
  });
});
