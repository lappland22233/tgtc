// @vitest-environment jsdom
import { createPinia, setActivePinia } from 'pinia';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * PERF-F-108 回归：应用级监听器（auth 的 `visibilitychange`、upload 的 `online`）
 * 提供显式释放路径。
 *
 * 行为约束（不可回退）：
 * - 监听默认**仍然常驻**（页面生命周期级），不因本次改动被自动取消；
 * - 释放函数幂等：重复调用不抛错，也不重复 removeEventListener；
 * - 释放后监听不再触发；重新注册（ensure）后恢复，且 ensure 本身幂等。
 *
 * 测试要点：pinia 每例新建实例会各自注册一份监听，因此每个用例结束都必须
 * 释放自己创建的 store，否则残留监听会串到后续用例（这正是本项要防的泄漏）。
 */

vi.mock('../api/client', () => ({
  default: { get: vi.fn(), post: vi.fn() },
  clearRedirectState: vi.fn(),
}));
vi.mock('../utils/message', () => ({
  default: { error: vi.fn(), success: vi.fn(), warning: vi.fn(), info: vi.fn() },
}));

import client from '../api/client';
import { useAuthStore } from './auth';
import { useUploadStore } from './upload';

type DisposableStore = {
  disposeAuthListeners?: () => void;
  disposeUploadListeners?: () => void;
};

describe('PERF-F-108 应用级监听器释放路径', () => {
  let addDocSpy: ReturnType<typeof vi.spyOn>;
  let removeDocSpy: ReturnType<typeof vi.spyOn>;
  let addWinSpy: ReturnType<typeof vi.spyOn>;
  let removeWinSpy: ReturnType<typeof vi.spyOn>;
  /** 本例创建的 store，afterEach 统一释放，避免监听跨例泄漏。 */
  let created: DisposableStore[];

  beforeEach(() => {
    setActivePinia(createPinia());
    created = [];
    vi.clearAllMocks();
    addDocSpy = vi.spyOn(document, 'addEventListener');
    removeDocSpy = vi.spyOn(document, 'removeEventListener');
    addWinSpy = vi.spyOn(window, 'addEventListener');
    removeWinSpy = vi.spyOn(window, 'removeEventListener');
  });

  afterEach(() => {
    for (const store of created) {
      store.disposeAuthListeners?.();
      store.disposeUploadListeners?.();
    }
    created = [];
    vi.restoreAllMocks();
  });

  const countFor = (spy: ReturnType<typeof vi.spyOn>, type: string) =>
    spy.mock.calls.filter((call) => call[0] === type).length;

  describe('auth store：visibilitychange', () => {
    it('store 定义时已注册 visibilitychange 监听（常驻语义不变）', () => {
      const auth = useAuthStore();
      created.push(auth);
      expect(countFor(addDocSpy, 'visibilitychange')).toBe(1);
    });

    it('未释放时 visibilitychange 会触发会话重拉（正向对照，证明监听确实活着）', () => {
      const auth = useAuthStore();
      created.push(auth);

      const get = vi.mocked(client.get);
      document.dispatchEvent(new Event('visibilitychange'));
      expect(get.mock.calls.length).toBeGreaterThan(0);
    });

    it('disposeAuthListeners 后监听不再触发，重复释放幂等不抛错', () => {
      const auth = useAuthStore();
      created.push(auth);
      const get = vi.mocked(client.get);

      // 先确认释放前监听有效
      document.dispatchEvent(new Event('visibilitychange'));
      const beforeDispose = get.mock.calls.length;
      expect(beforeDispose).toBeGreaterThan(0);

      auth.disposeAuthListeners();
      expect(countFor(removeDocSpy, 'visibilitychange')).toBe(1);

      // 释放后触发：不得再拉取 /auth/me
      document.dispatchEvent(new Event('visibilitychange'));
      expect(get.mock.calls.length).toBe(beforeDispose);

      const removedAfterFirst = countFor(removeDocSpy, 'visibilitychange');
      expect(() => auth.disposeAuthListeners()).not.toThrow();
      expect(() => auth.disposeAuthListeners()).not.toThrow();
      // handler 已置空 → 后续调用早退，不再重复 removeEventListener
      expect(countFor(removeDocSpy, 'visibilitychange')).toBe(removedAfterFirst);
    });

    it('closeAuthChannel（App.vue 卸载路径）同时释放监听，既有调用方行为不变', () => {
      const auth = useAuthStore();
      created.push(auth);
      const get = vi.mocked(client.get);

      document.dispatchEvent(new Event('visibilitychange'));
      const before = get.mock.calls.length;

      expect(() => auth.closeAuthChannel()).not.toThrow();
      expect(countFor(removeDocSpy, 'visibilitychange')).toBe(1);

      document.dispatchEvent(new Event('visibilitychange'));
      expect(get.mock.calls.length).toBe(before);
    });
  });

  describe('upload store：online', () => {
    it('ensureUploadListeners 幂等：重复调用不重复 addEventListener', () => {
      const upload = useUploadStore();
      created.push(upload);

      // 模块导入时已注册过一份；这里先释放再重新走 ensure 路径
      upload.disposeUploadListeners();
      const afterDispose = countFor(addWinSpy, 'online');

      upload.ensureUploadListeners();
      upload.ensureUploadListeners();
      upload.ensureUploadListeners();
      // 幂等：三次 ensure 只新增一次注册
      expect(countFor(addWinSpy, 'online')).toBe(afterDispose + 1);
    });

    it('disposeUploadListeners 幂等且重复调用不抛错', () => {
      const upload = useUploadStore();
      created.push(upload);

      // online 监听是模块级单例（与原实现一致），前序用例的 afterEach 可能已释放；
      // 先确保处于「已注册」状态，再验证释放路径。
      upload.ensureUploadListeners();
      upload.disposeUploadListeners();
      const removedOnce = countFor(removeWinSpy, 'online');
      expect(removedOnce).toBeGreaterThanOrEqual(1);

      // 已解绑：触发 online 不应有任何副作用
      expect(() => window.dispatchEvent(new Event('online'))).not.toThrow();

      expect(() => upload.disposeUploadListeners()).not.toThrow();
      expect(() => upload.disposeUploadListeners()).not.toThrow();
      expect(countFor(removeWinSpy, 'online')).toBe(removedOnce);
    });

    it('释放后可经 ensureUploadListeners 重新注册（自愈路径）', () => {
      const upload = useUploadStore();
      created.push(upload);

      upload.disposeUploadListeners();
      upload.ensureUploadListeners();
      expect(countFor(addWinSpy, 'online')).toBeGreaterThanOrEqual(1);

      // 重新注册后能再次正常触发
      expect(() => window.dispatchEvent(new Event('online'))).not.toThrow();
    });
  });
});