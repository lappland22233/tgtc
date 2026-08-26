// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import CustomVideoPlayer from './CustomVideoPlayer.vue';

vi.mock('@/utils/message', () => ({ default: { error: vi.fn(), success: vi.fn(), warning: vi.fn(), info: vi.fn() } }));

function setRect(el: Element, left = 0, width = 100) {
  vi.spyOn(el, 'getBoundingClientRect').mockReturnValue({ left, width, top: 0, height: 4, right: left + width, bottom: 4, x: left, y: 0, toJSON: () => ({}) });
}

function mountPlayer(cold = false) {
  const wrapper = mount(CustomVideoPlayer, { props: { src: '/video.mp4', cold } });
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
    progress.element.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, clientX: 10, pointerId: 1 }));
    progress.element.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, clientX: 70, pointerId: 1 }));
    expect(video.currentTime).toBe(10);

    progress.element.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, clientX: 70, pointerId: 1 }));
    expect(video.currentTime).toBe(70);
    progress.element.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, clientX: 80, pointerId: 1 }));
    expect(video.currentTime).toBe(70);
  });

  it('pointercancel 不提交，并恢复到媒体实际位置', async () => {
    const { video, progress } = mountPlayer();
    const spy = vi.mocked(video.fastSeek);
    progress.element.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, clientX: 10, pointerId: 2 }));
    progress.element.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, clientX: 80, pointerId: 2 }));
    progress.element.dispatchEvent(new PointerEvent('pointercancel', { bubbles: true, clientX: 80, pointerId: 2 }));
    expect(spy).not.toHaveBeenCalled();
    expect(video.currentTime).toBe(10);
  });

  it('冷资源可跳转到未缓冲位置，释放后的旧 timeupdate 不会让进度条回弹', async () => {
    const { wrapper, video, progress } = mountPlayer(true);
    Object.defineProperty(video, 'buffered', { configurable: true, value: { length: 1, end: () => 20 } });

    progress.element.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, clientX: 10, pointerId: 3 }));
    progress.element.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, clientX: 80, pointerId: 3 }));
    progress.element.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, clientX: 80, pointerId: 3 }));

    expect(video.currentTime).toBe(80);
    await wrapper.vm.$nextTick();
    expect(wrapper.find('.cvp__progress-played').attributes('style')).toContain('80%');

    video.currentTime = 10;
    video.dispatchEvent(new Event('timeupdate'));
    await wrapper.vm.$nextTick();
    expect(wrapper.find('.cvp__progress-played').attributes('style')).toContain('80%');

    video.currentTime = 80;
    video.dispatchEvent(new Event('seeked'));
    await wrapper.vm.$nextTick();
    expect(wrapper.find('.cvp__progress-played').attributes('style')).toContain('80%');
  });

  it('连续键盘跳转以后一次目标为准', async () => {
    const { wrapper, video, progress } = mountPlayer(true);
    progress.element.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'ArrowRight' }));
    progress.element.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'ArrowRight' }));

    expect(video.currentTime).toBe(20);
    video.currentTime = 10;
    video.dispatchEvent(new Event('timeupdate'));
    await wrapper.vm.$nextTick();
    expect(wrapper.find('.cvp__progress-played').attributes('style')).toContain('20%');
  });
});
