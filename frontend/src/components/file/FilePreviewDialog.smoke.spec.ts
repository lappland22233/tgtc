// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { DOMWrapper, flushPromises, mount } from '@vue/test-utils';
import { createPinia } from 'pinia';
import { useMediaPlaybackStore, type MediaSessionItem } from '@/stores/mediaPlayback';

vi.mock('tdesign-vue-next/es/message', () => ({
  MessagePlugin: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() },
}));
vi.mock('tdesign-vue-next/es/dialog', () => ({
  DialogPlugin: { confirm: vi.fn(), alert: vi.fn(), info: vi.fn(), warning: vi.fn() },
}));

import FilePreviewDialog from './FilePreviewDialog.vue';
import PreviewPlaylistPanel from './PreviewPlaylistPanel.vue';
import PreviewTextPanel from './PreviewTextPanel.vue';

/** 预览宿主与展示组件的编译契约，以及真实图片会话中的容器绑定。 */
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

  it('sizes an image using its mounted preview stage and restores full size on double click', async () => {
    vi.stubGlobal('Image', class {
      naturalWidth = 800;
      naturalHeight = 600;
      onload?: () => void;
      set src(_url: string) { queueMicrotask(() => this.onload?.()); }
    });
    vi.spyOn(Element.prototype, 'clientWidth', 'get').mockImplementation(function (this: Element) {
      return this.matches('.fpv-image-stage') ? 400 : 0;
    });
    vi.spyOn(Element.prototype, 'clientHeight', 'get').mockImplementation(function (this: Element) {
      return this.matches('.fpv-image-stage') ? 300 : 0;
    });
    const pinia = createPinia();
    const media = useMediaPlaybackStore(pinia);
    const item: MediaSessionItem = { id: 'photo', name: 'photo.jpg', mimeType: 'image/jpeg', kind: 'image', src: '/photos/photo.jpg' };
    media.open({ item, context: { type: 'user', userId: 'owner' }, playlist: [item], playlistIndex: 0 });
    const wrapper = mount(FilePreviewDialog, { global: { plugins: [pinia] } });
    const page = new DOMWrapper(document.body);
    try {
      await flushPromises();
      const stage = page.get('.fpv-image-stage');
      const img = stage.get('img');
      Object.defineProperties(img.element, { naturalWidth: { value: 800 }, naturalHeight: { value: 600 } });
      await img.trigger('load');
      expect(page.get('.fpv-image').attributes('style')).toContain('scale(0.5)');
      await page.get('.fpv-image-stage').trigger('dblclick');
      expect(page.get('.fpv-image').attributes('style')).toContain('scale(1)');
    } finally {
      wrapper.unmount();
      vi.unstubAllGlobals();
      vi.restoreAllMocks();
    }
  });
});
