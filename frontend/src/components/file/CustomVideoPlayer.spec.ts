// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import CustomVideoPlayer from './CustomVideoPlayer.vue';

vi.mock('@/utils/message', () => ({ default: { error: vi.fn(), success: vi.fn(), warning: vi.fn(), info: vi.fn() } }));

function setRect(el: Element, left = 0, width = 100) {
  vi.spyOn(el, 'getBoundingClientRect').mockReturnValue({ left, width, top: 0, height: 4, right: left + width, bottom: 4, x: left, y: 0, toJSON: () => ({}) });
}

function mountPlayer() {
  const wrapper = mount(CustomVideoPlayer, { props: { src: '/video.mp4' } });
  const video = wrapper.find('video').element as HTMLVideoElement;
  Object.defineProperty(video, 'duration', { configurable: true, value: 100, writable: true });
  Object.defineProperty(video, 'currentTime', { configurable: true, value: 10, writable: true });
  Object.defineProperty(video, 'fastSeek', { configurable: true, value: vi.fn() });
  video.dispatchEvent(new Event('loadedmetadata'));
  const progress = wrapper.find('.cvp__progress');
  setRect(progress.element);
  progress.element.setPointerCapture = vi.fn();
  progress.element.hasPointerCapture = vi.fn(() => true);
  progress.element.releasePointerCapture = vi.fn();
  return { wrapper, video, progress };
}

describe('CustomVideoPlayer 进度指针交互', () => {
  beforeEach(() => localStorage.clear());

  it('pointermove 只更新预览，不真实 seek；pointerup 只提交一次', async () => {
    const { video, progress } = mountPlayer();
    const spy = vi.mocked(video.fastSeek);
    progress.element.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, clientX: 10, pointerId: 1 }));
    progress.element.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, clientX: 70, pointerId: 1 }));
    expect(spy).not.toHaveBeenCalled();
    expect(video.currentTime).toBe(10);

    progress.element.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, clientX: 70, pointerId: 1 }));
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith(70);
    progress.element.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, clientX: 80, pointerId: 1 }));
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('pointercancel 不提交，并恢复到媒体实际位置', async () => {
    const { wrapper, video, progress } = mountPlayer();
    const spy = vi.mocked(video.fastSeek);
    progress.element.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, clientX: 10, pointerId: 2 }));
    progress.element.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, clientX: 80, pointerId: 2 }));
    progress.element.dispatchEvent(new PointerEvent('pointercancel', { bubbles: true, clientX: 80, pointerId: 2 }));
    expect(spy).not.toHaveBeenCalled();
    expect(video.currentTime).toBe(10);
    expect(wrapper.emitted('seeking-change')).toEqual([[true], [false]]);
  });
});
