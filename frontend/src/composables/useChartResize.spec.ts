// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { defineComponent, h } from 'vue';
import { mount } from '@vue/test-utils';
import { useChartResize, throttleToFrame } from './useChartResize';

/**
 * PERF-F-106 回归：
 * 1) 监听在挂载时注册、卸载时解绑（不得残留，避免泄漏）；
 * 2) 同一帧内多次 resize 只执行一次 handler（帧级节流），跨帧不丢帧；
 * 3) 卸载后不再响应 resize，且挂起的帧被取消（不对已 dispose 的图表 resize）。
 */

const realRaf = window.requestAnimationFrame;
const realCancelRaf = window.cancelAnimationFrame;

/** 手动驱动的 rAF 队列：让「同一帧多次触发」的语义在测试里可控。 */
let rafQueue: Array<FrameRequestCallback | null> = [];
let rafSeq = 0;

function installRafStub() {
  rafQueue = [];
  rafSeq = 0;
  window.requestAnimationFrame = ((cb: FrameRequestCallback) => {
    rafSeq += 1;
    rafQueue.push(cb);
    return rafSeq;
  }) as typeof window.requestAnimationFrame;
  window.cancelAnimationFrame = ((id: number) => {
    rafQueue[id - 1] = null;
  }) as typeof window.cancelAnimationFrame;
}

/** 执行当前队列中所有待执行帧（已取消的位置跳过）。 */
function flushFrames() {
  const pending = rafQueue;
  rafQueue = [];
  for (const cb of pending) cb?.(0);
}

function mountProbe(handler: () => void) {
  return mount(
    defineComponent({
      setup() {
        useChartResize(handler);
        return () => h('div');
      },
    }),
  );
}

describe('useChartResize（PERF-F-106 帧级节流）', () => {
  beforeEach(() => {
    installRafStub();
  });

  afterEach(() => {
    window.requestAnimationFrame = realRaf;
    window.cancelAnimationFrame = realCancelRaf;
    vi.restoreAllMocks();
  });

  it('挂载时注册 resize 监听，卸载时解绑同一个函数引用', () => {
    const addSpy = vi.spyOn(window, 'addEventListener');
    const removeSpy = vi.spyOn(window, 'removeEventListener');

    const wrapper = mountProbe(() => {});
    const resizeAdd = addSpy.mock.calls.find(([type]) => type === 'resize');
    expect(resizeAdd).toBeTruthy();

    wrapper.unmount();
    const resizeRemove = removeSpy.mock.calls.find(([type]) => type === 'resize');
    expect(resizeRemove).toBeTruthy();
    // 解绑的必须是同一函数引用，否则等于没解绑
    expect(resizeRemove?.[1]).toBe(resizeAdd?.[1]);
  });

  it('同一帧内多次 resize 只执行一次 handler', () => {
    const handler = vi.fn();
    const wrapper = mountProbe(handler);

    // 连续 5 次 resize 事件（模拟窗口拖拽的每像素触发）
    for (let i = 0; i < 5; i += 1) window.dispatchEvent(new Event('resize'));

    // 帧尚未刷新，handler 不应执行
    expect(handler).not.toHaveBeenCalled();
    expect(rafQueue).toHaveLength(1);

    flushFrames();
    expect(handler).toHaveBeenCalledTimes(1);
    wrapper.unmount();
  });

  it('跨帧时每帧各执行一次（不吞掉后续帧）', () => {
    const handler = vi.fn();
    const wrapper = mountProbe(handler);

    window.dispatchEvent(new Event('resize'));
    flushFrames();
    expect(handler).toHaveBeenCalledTimes(1);

    window.dispatchEvent(new Event('resize'));
    flushFrames();
    expect(handler).toHaveBeenCalledTimes(2);
    wrapper.unmount();
  });

  it('卸载后不再响应 resize，挂起的帧被取消', () => {
    const handler = vi.fn();
    const wrapper = mountProbe(handler);

    window.dispatchEvent(new Event('resize'));
    expect(rafQueue.filter(Boolean)).toHaveLength(1);

    wrapper.unmount();
    // 挂起的帧已被 cancelAnimationFrame 取消
    flushFrames();
    expect(handler).not.toHaveBeenCalled();

    // 监听已解绑：卸载后再触发 resize 也不再排队
    window.dispatchEvent(new Event('resize'));
    expect(rafQueue.filter(Boolean)).toHaveLength(0);
    flushFrames();
    expect(handler).not.toHaveBeenCalled();
  });

  it('无 requestAnimationFrame 时降级为 setTimeout，节流语义一致', async () => {
    window.requestAnimationFrame = undefined as unknown as typeof window.requestAnimationFrame;
    window.cancelAnimationFrame = undefined as unknown as typeof window.cancelAnimationFrame;

    const handler = vi.fn();
    const throttled = throttleToFrame(handler);

    throttled();
    throttled();
    throttled();
    // setTimeout 尚未到期：不应执行
    expect(handler).not.toHaveBeenCalled();

    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('throttleToFrame：cancel() 丢弃挂起帧且可重复调用', () => {
    const handler = vi.fn();
    const throttled = throttleToFrame(handler);

    throttled();
    throttled.cancel();
    flushFrames();
    expect(handler).not.toHaveBeenCalled();

    // 无挂起帧时重复 cancel 不抛错
    expect(() => throttled.cancel()).not.toThrow();
  });
});