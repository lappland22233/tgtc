// @vitest-environment jsdom
import { flushPromises, mount } from '@vue/test-utils';
import { describe, expect, it } from 'vitest';
import { createMemoryHistory, createRouter } from 'vue-router';
import WorkspaceAdminNavigation from './WorkspaceAdminNavigation.vue';

describe('管理后台导航', () => {
  it('只显示当前角色的入口，并同步窄屏选择和实际路由', async () => {
    const router = createRouter({
      history: createMemoryHistory(),
      routes: [{ path: '/admin/:section?', component: { render: () => null } }],
    });
    await router.push('/admin');
    const wrapper = mount(WorkspaceAdminNavigation, { props: { role: 'admin' }, global: { plugins: [router] } });

    expect(wrapper.findAll('option').map((option) => option.attributes('value')))
      .toEqual(['/admin', '/admin/users', '/admin/files']);
    expect(wrapper.find('a[href="/admin/config"]').exists()).toBe(false);

    const select = wrapper.get('select');
    await select.setValue('/admin/files');
    await flushPromises();
    expect(router.currentRoute.value.path).toBe('/admin/files');
    expect(wrapper.get('a[href="/admin/files"]').attributes('aria-current')).toBe('page');

    await wrapper.setProps({ role: 'super_admin' });
    expect(wrapper.find('option[value="/admin/config"]').exists()).toBe(true);
    await router.push('/admin/storage-backends');
    await flushPromises();
    expect(select.element.value).toBe('/admin/storage-backends');
    wrapper.unmount();
  });
});
