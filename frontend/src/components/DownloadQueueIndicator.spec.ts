// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';

// 隔离 TDesign message 的样式副作用（其 es/message 会 import 一个 .css）
vi.mock('../utils/message', () => ({
  default: { info: vi.fn(), success: vi.fn(), error: vi.fn(), warning: vi.fn() },
}));

import DownloadQueueIndicator from './DownloadQueueIndicator.vue';
import { useDownloadsStore, type DownloadJob } from '../stores/downloads';

function job(overrides: Partial<DownloadJob> = {}): DownloadJob {
  return {
    taskId: 'task-1',
    fileId: 'f1',
    fileName: 'big.bin',
    downloadUrl: '/api/files/f1/download',
    status: 'queued',
    queueReason: 'disk',
    message: '',
    createdAt: Date.now(),
    ...overrides,
  };
}

function mountIndicator() {
  return mount(DownloadQueueIndicator);
}

describe('DownloadQueueIndicator', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
  });

  it('无任务时不渲染', () => {
    const wrapper = mountIndicator();
    expect(wrapper.find('.download-queue').exists()).toBe(false);
  });

  it('排队中展示原因与取消入口，且保持 aria-live="polite"', () => {
    const store = useDownloadsStore();
    store.jobs = [job({ status: 'queued', queueReason: 'upstream' })];
    const wrapper = mountIndicator();

    const root = wrapper.find('.download-queue');
    expect(root.exists()).toBe(true);
    expect(root.attributes('role')).toBe('status');
    expect(root.attributes('aria-live')).toBe('polite');
    expect(wrapper.text()).toContain('排队中');
    expect(wrapper.find('.download-queue__cancel').exists()).toBe(true);
  });

  it('已就绪（cache）展示「正在交给浏览器」，不再提供取消', () => {
    const store = useDownloadsStore();
    store.jobs = [job({ status: 'streamable' })];
    const wrapper = mountIndicator();

    expect(wrapper.text()).toContain('已就绪');
    expect(wrapper.find('.download-queue__cancel').exists()).toBe(false);
  });

  it('直通下载（direct）文案明确，且绝不出现「下载成功」', () => {
    const store = useDownloadsStore();
    store.jobs = [job({ status: 'streamable', mode: 'direct' })];
    const wrapper = mountIndicator();

    const text = wrapper.text();
    expect(text).toContain('直通下载');
    expect(text).toContain('不占本地缓存');
    expect(text).not.toContain('下载成功');
  });

  it('过期任务展示过期提示', () => {
    const store = useDownloadsStore();
    store.jobs = [job({ status: 'expired', message: '下载任务已过期，请重新发起下载' })];
    const wrapper = mountIndicator();

    expect(wrapper.text()).toContain('已过期');
  });
});
