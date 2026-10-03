import { onMounted, onUnmounted } from 'vue';

// ============================================================
// PERF-F-106：图表 resize 监听节流
//
// 背景：ECharts 页面此前直接 `window.addEventListener('resize', handler)`，
// 窗口拖拽时浏览器每个像素都会触发一次 `chart.resize()`（内部读 offsetWidth /
// 重排并重绘 canvas），在多图表页面上足以造成可感知的掉帧。
//
// 语义：用 requestAnimationFrame 做帧级节流 —— 同一帧内无论触发多少次 resize，
// 只在下一帧执行一次 handler；卸载时解绑监听并取消挂起的帧，避免泄漏与"卸载后
// 仍 resize 已 dispose 图表"的报错。
//
// 降级：SSR / jsdom 等无 requestAnimationFrame 的环境退回 setTimeout(0)，
// 保证同一 tick 内的多次触发仍只执行一次（语义一致，仅延迟一帧）。
// ============================================================

/** 挂起的帧句柄：rAF 环境为 id，setTimeout 环境为 timer id，二者统一由此持有。 */
type PendingFrame = number | null;

/** 当前环境是否提供 requestAnimationFrame（每次调用时重新探测，允许测试注入桩）。 */
function hasRaf(): boolean {
  return typeof window !== 'undefined' && typeof window.requestAnimationFrame === 'function';
}

/**
 * 把回调包装为「同一帧内只执行一次」的节流函数。
 *
 * 导出以便单测直接验证节流语义（不依赖组件挂载），也可在需要时单独复用。
 * 返回值额外暴露 `cancel()`，用于丢弃挂起但尚未执行的那一帧。
 */
export interface ThrottledFn {
  (): void;
  /** 取消挂起但尚未执行的帧；无挂起帧时为空操作。 */
  cancel(): void;
}

export function throttleToFrame(handler: () => void): ThrottledFn {
  let pending: PendingFrame = null;

  const throttled = (() => {
    // 已有挂起帧：同一帧内重复触发直接吞掉，等下一帧统一执行一次。
    if (pending !== null) return;
    if (hasRaf()) {
      pending = window.requestAnimationFrame(() => {
        pending = null;
        handler();
      });
      return;
    }
    pending = window.setTimeout(() => {
      pending = null;
      handler();
    }, 0) as unknown as number;
  }) as ThrottledFn;

  throttled.cancel = () => {
    if (pending === null) return;
    if (hasRaf()) window.cancelAnimationFrame(pending);
    else window.clearTimeout(pending as unknown as ReturnType<typeof setTimeout>);
    pending = null;
  };

  return throttled;
}

/**
 * 注册窗口 resize 监听，并以「每帧最多一次」的节奏调用 `handler`。
 *
 * - 注册：组件 `onMounted`；卸载：`onUnmounted` 解绑 + 取消挂起帧（必须配对）。
 * - 不改变图表 resize 语义：handler 收到的仍是原始调用时机，本 composable
 *   只做频率抑制；页面里基于 tab watch / nextTick 的主动 resize 逻辑保持不变。
 * - handler 异常不得逃逸到 rAF 回调（否则整帧丢失），此处按原样抛出到控制台。
 */
export function useChartResize(handler: () => void) {
  const throttled = throttleToFrame(handler);
  const target = typeof window !== 'undefined' ? window : null;

  onMounted(() => {
    target?.addEventListener('resize', throttled, { passive: true });
  });

  onUnmounted(() => {
    target?.removeEventListener('resize', throttled);
    // 卸载后可能仍有未执行的帧：取消它，避免对已 dispose 的图表调用 resize()
    throttled.cancel();
  });

  return throttled;
}