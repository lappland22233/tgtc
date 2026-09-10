// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';

vi.mock('tdesign-vue-next/es/message', () => ({
  MessagePlugin: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() },
}));
vi.mock('tdesign-vue-next/es/dialog', () => ({
  DialogPlugin: { confirm: vi.fn(), alert: vi.fn(), info: vi.fn(), warning: vi.fn() },
}));

import FilePreviewDialog from './FilePreviewDialog.vue';
import PreviewPlaylistPanel from './PreviewPlaylistPanel.vue';
import PreviewTextPanel from './PreviewTextPanel.vue';

/**
 * M6 拆分专项的编译守卫。
 *
 * FilePreviewDialog 体量大、无独立单测（真实挂载依赖活跃媒体会话），
 * 拆分过程中最容易出问题的是 SFC 编译本身（模板绑定、<style src> 共享样式块、
 * 拆出组件的 props/emits 契约）。本用例通过真实 import 触发完整的 SFC 编译，
 * 保证上述问题在测试阶段就暴露，而不是等到 vite build。
 *
 * 注意：这里只做编译与静态断言，不挂载（挂载需构造完整媒体会话，
 * 行为契约由 PreviewPlaylistPanel.spec.ts / PreviewTextPanel.spec.ts 覆盖）。
 */
describe('FilePreviewDialog 拆分编译守卫', () => {
  it('宿主与拆出的展示组件均可正常编译加载', () => {
    expect(FilePreviewDialog).toBeTruthy();
    expect(PreviewPlaylistPanel).toBeTruthy();
    expect(PreviewTextPanel).toBeTruthy();
  });

  it('拆出的展示组件带有稳定名称，便于模板与调试定位', () => {
    expect((FilePreviewDialog as { __name?: string }).__name).toBe('FilePreviewDialog');
    expect((PreviewPlaylistPanel as { __name?: string }).__name).toBe('PreviewPlaylistPanel');
    expect((PreviewTextPanel as { __name?: string }).__name).toBe('PreviewTextPanel');
  });
});
