import { describe, expect, it, vi } from 'vitest';

// utils/preview 间接引入 TDesign 子路径（其样式为裸 .css，Node 侧不可直接加载）
vi.mock('tdesign-vue-next/es/message', () => ({
  MessagePlugin: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() },
}));
vi.mock('tdesign-vue-next/es/dialog', () => ({
  DialogPlugin: { confirm: vi.fn(), alert: vi.fn(), info: vi.fn(), warning: vi.fn() },
}));

import {
  FORCE_DELETE_WAIT_MS,
  canPreviewFile,
  getFileRowClassName,
  isFileActionable,
  selfForceDeleteReady,
} from './file-row-predicates';

/**
 * M6 拆分回归：行判定原先内联在 FileList.vue，桌面/移动列表拆出后由三方共用，
 * 本用例锁定判定语义（尤其 isDeleted / processing 的优先级与冷静期边界）。
 */

const base = {
  id: 'f1',
  originalName: 'report.pdf',
  mimeType: 'application/pdf',
  size: 1024,
  status: 'ready' as const,
  isDeleted: false,
  deleteRequestedAt: null as string | null,
};

describe('isFileActionable', () => {
  it('正常文件可操作', () => {
    expect(isFileActionable(base)).toBe(true);
  });

  it('处理中或已删除不可操作', () => {
    expect(isFileActionable({ ...base, status: 'processing' })).toBe(false);
    expect(isFileActionable({ ...base, isDeleted: true })).toBe(false);
  });
});

describe('canPreviewFile', () => {
  it('可预览类型且状态正常时可预览', () => {
    expect(canPreviewFile(base)).toBe(true);
    expect(canPreviewFile({ ...base, mimeType: 'image/png', originalName: 'a.png' })).toBe(true);
  });

  it('不可预览类型（如压缩包）返回 false', () => {
    expect(canPreviewFile({ ...base, mimeType: 'application/zip', originalName: 'a.zip' })).toBe(false);
  });

  it('已删除或处理中的文件不可预览', () => {
    expect(canPreviewFile({ ...base, isDeleted: true })).toBe(false);
    expect(canPreviewFile({ ...base, status: 'processing' })).toBe(false);
  });
});

describe('getFileRowClassName', () => {
  it('处理中优先于已删除', () => {
    expect(getFileRowClassName({ status: 'processing', isDeleted: false })).toBe('row-processing');
    expect(getFileRowClassName({ status: 'ready', isDeleted: true })).toBe('row-deleted');
    expect(getFileRowClassName({ status: 'ready', isDeleted: false })).toBe('');
  });
});

describe('selfForceDeleteReady', () => {
  const requestedAt = '2026-09-10T10:00:00.000Z';

  it('未请求删除时不可自助永久删除', () => {
    expect(selfForceDeleteReady({ deleteRequestedAt: null })).toBe(false);
  });

  it('未满冷静期不可，恰好满冷静期可', () => {
    const start = new Date(requestedAt).getTime();

    expect(selfForceDeleteReady({ deleteRequestedAt: requestedAt }, start + FORCE_DELETE_WAIT_MS - 1)).toBe(false);
    expect(selfForceDeleteReady({ deleteRequestedAt: requestedAt }, start + FORCE_DELETE_WAIT_MS)).toBe(true);
    expect(selfForceDeleteReady({ deleteRequestedAt: requestedAt }, start + FORCE_DELETE_WAIT_MS + 1)).toBe(true);
  });
});
