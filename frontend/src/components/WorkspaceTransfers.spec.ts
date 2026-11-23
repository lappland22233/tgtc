// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { nextTick, ref } from 'vue';
import { mount, type VueWrapper } from '@vue/test-utils';
import { createPinia } from 'pinia';
import { createMemoryHistory, createRouter } from 'vue-router';
import { WORKSPACE_TRANSFERS } from '@/composables/workspaceTransfers';
import { useDownloadsStore } from '@/stores/downloads';
import { useUploadStore } from '@/stores/upload';
import WorkspaceTransfers from './WorkspaceTransfers.vue';

vi.mock('@/utils/message', () => ({
  default: { info: vi.fn(), success: vi.fn(), error: vi.fn(), warning: vi.fn() },
}));
vi.mock('tdesign-vue-next/es/dialog', () => ({ DialogPlugin: { confirm: vi.fn() } }));

let wrapper: VueWrapper | undefined;

async function mountTransfers(dockTarget: HTMLElement | null = null) {
  const pinia = createPinia();
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/files', name: 'UserFiles', component: {} },
      { path: '/shares', component: {} },
    ],
  });
  await router.push('/files');
  const transfers = { target: ref(dockTarget), visible: ref(false) };
  const uploadStore = useUploadStore(pinia);
  const downloadsStore = useDownloadsStore(pinia);
  wrapper = mount(WorkspaceTransfers, {
    attachTo: document.body,
    global: { plugins: [pinia, router], provide: { [WORKSPACE_TRANSFERS]: transfers } },
  });
  return { wrapper, router, transfers, uploadStore, downloadsStore };
}

afterEach(() => {
  wrapper?.unmount();
  wrapper = undefined;
  document.body.replaceChildren();
});

describe('WorkspaceTransfers', () => {
  it('opens the fallback panel and restores keyboard focus after Escape', async () => {
    const { wrapper } = await mountTransfers();
    const trigger = wrapper.get('button[aria-controls="workspace-transfer-panel"]');
    expect(trigger.attributes('aria-expanded')).toBe('false');
    expect(wrapper.get(`#${trigger.attributes('aria-controls')}`).isVisible()).toBe(false);

    await trigger.trigger('click');
    expect(trigger.attributes('aria-expanded')).toBe('true');
    expect(wrapper.text()).toContain('暂无传输任务');
    const close = wrapper.get('button[aria-label="关闭传输面板"]');
    await nextTick();
    expect(document.activeElement).toBe(close.element);

    await close.trigger('keydown', { key: 'Escape' });
    expect(trigger.attributes('aria-expanded')).toBe('false');
    expect(document.activeElement).toBe(trigger.element);
  });

  it('docks the shared panel, reflects both queues and closes on route navigation', async () => {
    const target = document.createElement('aside');
    document.body.append(target);
    const { wrapper, transfers, router, uploadStore, downloadsStore } = await mountTransfers(target);
    uploadStore.activeCount = 1;
    uploadStore.queuedCount = 2;
    downloadsStore.jobs = [{
      taskId: 'queued',
      fileId: 'file-1',
      fileName: '资料.zip',
      status: 'queued',
      message: '前面还有一个下载任务',
      downloadUrl: '',
      createdAt: Date.now(),
    }];
    const cancel = vi.spyOn(downloadsStore, 'cancel').mockResolvedValue(undefined);
    const trigger = wrapper.get('button[aria-controls="workspace-transfer-panel"]');
    await trigger.trigger('click');

    expect(transfers.visible.value).toBe(true);
    expect(trigger.attributes('aria-label')).toBe('传输，4 个任务');
    expect(target.textContent).toContain('资料.zip');
    target.querySelector<HTMLButtonElement>('[aria-label="取消下载 资料.zip"]')?.click();
    expect(cancel).toHaveBeenCalledWith('queued');

    await router.push('/shares');
    await nextTick();
    expect(transfers.visible.value).toBe(false);
    expect(trigger.attributes('aria-expanded')).toBe('false');
  });
});
