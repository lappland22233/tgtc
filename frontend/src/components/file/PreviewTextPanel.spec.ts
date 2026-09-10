// @vitest-environment jsdom
import { mount } from '@vue/test-utils';
import { describe, expect, it, vi } from 'vitest';

vi.mock('tdesign-vue-next/es/message', () => ({
  MessagePlugin: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() },
}));
vi.mock('tdesign-vue-next/es/dialog', () => ({
  DialogPlugin: { confirm: vi.fn(), alert: vi.fn(), info: vi.fn(), warning: vi.fn() },
}));

import PreviewTextPanel from './PreviewTextPanel.vue';

/**
 * M6 拆分回归：文本预览面板从 FilePreviewDialog.vue 拆出后，
 * 三态优先级、工具栏元信息与下载意图回传必须与拆分前一致。
 */

function mountPanel(overrides: Record<string, unknown> = {}) {
  return mount(PreviewTextPanel, {
    props: {
      loading: false,
      tooLarge: false,
      errorMessage: null,
      mimeType: 'text/plain',
      size: 2048,
      charCount: 12,
      content: 'hello world!',
      ...overrides,
    },
    global: {
      stubs: {
        't-icon': { template: '<i class="icon-stub" />' },
        't-loading': { template: '<div class="loading-stub" />' },
      },
    },
  });
}

describe('PreviewTextPanel（M6 拆分契约）', () => {
  it('加载中优先展示加载态，不渲染正文', () => {
    const wrapper = mountPanel({ loading: true });

    expect(wrapper.find('.loading-stub').exists()).toBe(true);
    expect(wrapper.find('.fpv-text-panel').exists()).toBe(false);
  });

  it('超限时展示「文件过大，请下载查看」且不渲染正文', () => {
    const wrapper = mountPanel({ tooLarge: true });

    expect(wrapper.get('.fpv-state').classes()).toContain('fpv-error');
    expect(wrapper.text()).toContain('文件过大，请下载查看');
    expect(wrapper.find('.fpv-text-panel').exists()).toBe(false);
  });

  it('读取失败时展示后端原因并回传 download 事件', async () => {
    const wrapper = mountPanel({ errorMessage: '文本读取失败' });

    expect(wrapper.text()).toContain('文本读取失败');

    await wrapper.get('.fpv-btn').trigger('click');
    expect(wrapper.emitted('download')).toEqual([[]]);
  });

  it('正常态渲染工具栏元信息（MIME / 大小 / 字符数）与正文', () => {
    const wrapper = mountPanel();

    expect(wrapper.find('.fpv-text-panel').exists()).toBe(true);
    const meta = wrapper.get('.fpv-text-toolbar-meta').text();
    expect(meta).toContain('text/plain');
    // formatSizeCompact：2048 bytes → 2.0 KB（1 位小数，与拆分前一致）
    expect(meta).toContain('2.0 KB');
    expect(meta).toContain('12 字符');
    expect(wrapper.get('.fpv-text').text()).toBe('hello world!');
  });

  it('charCount 为 0 时不展示字符数', () => {
    const wrapper = mountPanel({ charCount: 0 });

    expect(wrapper.get('.fpv-text-toolbar-meta').text()).not.toContain('字符');
  });

  it('size 未知时不展示大小，但保留 MIME 与字符数', () => {
    const wrapper = mountPanel({ size: null });
    const meta = wrapper.get('.fpv-text-toolbar-meta').text();

    expect(meta).toBe('text/plain · 12 字符');
    expect(meta).not.toContain('KB');
  });
});
