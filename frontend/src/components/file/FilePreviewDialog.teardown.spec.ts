// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { DOMWrapper, flushPromises, mount } from '@vue/test-utils';
import { createPinia } from 'pinia';
import { useMediaPlaybackStore, type MediaSessionItem } from '@/stores/mediaPlayback';

vi.mock('tdesign-vue-next/es/message', () => ({
  MessagePlugin: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() },
}));
vi.mock('tdesign-vue-next/es/dialog', () => ({
  DialogPlugin: { confirm: vi.fn(), alert: vi.fn(), info: vi.fn(), warning: vi.fn() },
}));

// 缩略图工具会真实请求 /files/public-key，测试里必须断开网络依赖
vi.mock('@/utils/thumbnail', () => ({
  getThumbToken: vi.fn(async () => 'thumb-token'),
  acquireThumbnailSlot: vi.fn(async () => {}),
  releaseThumbnailSlot: vi.fn(),
  buildThumbUrl: vi.fn(async (id: string) => `/thumb/${id}`),
  buildHdThumbUrl: vi.fn(async (id: string) => `/thumb-hd/${id}`),
  clearThumbToken: vi.fn(),
}));

import FilePreviewDialog from './FilePreviewDialog.vue';

/**
 * B-14：预览弹窗此前只有编译守卫 + 1 个图像用例，资源释放无行为测试。
 *
 * 关键不变量：切换媒体 / 停止 / 卸载时必须中止拉流并释放资源，
 * 否则后台媒体请求继续消耗带宽，objectURL 泄漏，且上一个视频的音频可能继续播放。
 * 释放手法是 pause() + removeAttribute('src') + load()（与音频路径对齐）。
 */
function videoItem(id: string, src: string): MediaSessionItem {
  return { id, name: `${id}.mp4`, mimeType: 'video/mp4', kind: 'video', src };
}

describe('FilePreviewDialog 资源释放（B-14）', () => {
  let loadSpy: ReturnType<typeof vi.spyOn>;
  let pauseSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    loadSpy = vi.spyOn(HTMLMediaElement.prototype, 'load').mockImplementation(() => {});
    pauseSpy = vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function openVideo(item: MediaSessionItem) {
    const pinia = createPinia();
    const media = useMediaPlaybackStore(pinia);
    media.open({ item, context: { type: 'user', userId: 'owner' }, playlist: [item], playlistIndex: 0 });
    const wrapper = mount(FilePreviewDialog, { global: { plugins: [pinia] } });
    return { pinia, media, wrapper, page: new DOMWrapper(document.body) };
  }

  it('卸载时中止视频拉流：pause + 移除 src + load()', async () => {
    const { wrapper, page } = openVideo(videoItem('v1', '/media/v1.mp4'));
    try {
      await flushPromises();
      const video = page.find('video');
      expect(video.exists()).toBe(true);
      loadSpy.mockClear();
      pauseSpy.mockClear();

      wrapper.unmount();
      await flushPromises();

      expect(pauseSpy).toHaveBeenCalled();
      expect(loadSpy).toHaveBeenCalled();
    } finally {
      if (wrapper.exists()) wrapper.unmount();
    }
  });

  it('切换到另一个媒体时先释放上一个视频', async () => {
    const first = videoItem('v1', '/media/v1.mp4');
    const { media, wrapper, page } = openVideo(first);
    try {
      await flushPromises();
      expect(page.find('video').exists()).toBe(true);
      loadSpy.mockClear();
      pauseSpy.mockClear();

      const second = videoItem('v2', '/media/v2.mp4');
      media.open({ item: second, context: { type: 'user', userId: 'owner' }, playlist: [second], playlistIndex: 0 });
      await flushPromises();

      // 切换必须触发旧视频的停止流程，否则旧流继续拉取
      expect(pauseSpy).toHaveBeenCalled();
      expect(loadSpy).toHaveBeenCalled();
    } finally {
      wrapper.unmount();
    }
  });

  it('停止会话后不再残留 video 元素', async () => {
    const { media, wrapper, page } = openVideo(videoItem('v1', '/media/v1.mp4'));
    try {
      await flushPromises();
      expect(page.find('video').exists()).toBe(true);

      media.requestStop();
      await flushPromises();

      expect(page.find('video').exists()).toBe(false);
    } finally {
      wrapper.unmount();
    }
  });

  it('释放流程不抛错（重复 teardown 幂等）', async () => {
    const { media, wrapper } = openVideo(videoItem('v1', '/media/v1.mp4'));
    try {
      await flushPromises();
      media.requestStop();
      await flushPromises();
      // 再次停止与卸载不得因重复清理而抛错
      expect(() => media.requestStop()).not.toThrow();
      expect(() => wrapper.unmount()).not.toThrow();
      await flushPromises();
    } finally {
      if (wrapper.exists()) wrapper.unmount();
    }
  });

});