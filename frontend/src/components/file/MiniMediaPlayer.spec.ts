// @vitest-environment jsdom
import { createPinia, setActivePinia } from 'pinia';
import { shallowMount } from '@vue/test-utils';
import { describe, expect, it, vi } from 'vitest';
import { useMediaPlaybackStore } from '@/stores/mediaPlayback';
import MiniMediaPlayer from './MiniMediaPlayer.vue';

vi.mock('@/api/client', () => ({ default: { get: vi.fn() } }));

describe('minimized share playback', () => {
  it('routes transport, seeking, expand and close actions to the current playback session', async () => {
    setActivePinia(createPinia());
    const media = useMediaPlaybackStore();
    const playlist = ['a', 'b', 'c'].map(id => ({
      id, name: id + '.mp4', kind: 'video' as const, mimeType: 'video/mp4', src: '/preview/' + id,
    }));
    media.open({ context: { type: 'share', token: 'share-a' }, item: playlist[1], playlist, playlistIndex: 1 });
    const bridge = {
      play: vi.fn(), pause: vi.fn(), togglePlay: vi.fn(), seekBy: vi.fn(), seekTo: vi.fn(),
      prev: vi.fn(), next: vi.fn(), stop: vi.fn(() => media.clearSession()),
    };
    media.registerBridge(bridge);
    media.setProgress(10, 100);
    media.minimize();
    const wrapper = shallowMount(MiniMediaPlayer, { global: { stubs: { teleport: true } } });
    try {
      await wrapper.get('[aria-label="上一个"]').trigger('click');
      await wrapper.get('[aria-label="播放"]').trigger('click');
      await wrapper.get('[aria-label="下一个"]').trigger('click');
      expect(bridge.prev).toHaveBeenCalledOnce();
      expect(bridge.togglePlay).toHaveBeenCalledOnce();
      expect(bridge.next).toHaveBeenCalledOnce();

      const progress = wrapper.get('[role="slider"]');
      vi.spyOn(progress.element, 'getBoundingClientRect').mockReturnValue({ left: 10, width: 200 } as DOMRect);
      await progress.trigger('click', { clientX: 110 });
      expect(bridge.seekTo).toHaveBeenCalledWith(50);
      await progress.trigger('keydown', { key: 'ArrowRight' });
      await progress.trigger('keydown', { key: 'ArrowLeft' });
      expect(bridge.seekBy.mock.calls).toEqual([[5], [-5]]);

      for (const selector of ['.mmp__video', '.mmp__identity', '[title="展开预览"]']) {
        media.minimize();
        await wrapper.get(selector).trigger('click');
        expect(media.expanded).toBe(true);
        expect(media.session?.item.id).toBe('b');
      }
      await wrapper.get('[title="停止播放并关闭"]').trigger('click');
      expect(bridge.stop).toHaveBeenCalledOnce();
      expect(media.session).toBeNull();
      expect(wrapper.find('[role="region"]').exists()).toBe(false);
    } finally {
      wrapper.unmount();
      media.unregisterBridge();
    }
  });
});
