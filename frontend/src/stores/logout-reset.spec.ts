// @vitest-environment jsdom
import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * M7 回归：登出必须清空所有会话相关的业务 store，避免同标签页换账号后
 * 短暂显示上一个账号的文件、目录、标签与播放进度。
 */

vi.mock('../api/client', () => ({
  default: {
    get: vi.fn(async () => ({ data: { code: 0, data: {} } })),
    post: vi.fn(async () => ({ data: { code: 0, data: {} } })),
  },
  clearRedirectState: vi.fn(),
}));

import { useAuthStore } from './auth';
import { useFileStore } from './files';
import { useFolderStore } from './folders';
import { useTagStore } from './tags';
import { DEFAULT_MAX_FILE_SIZE_BYTES, useUploadConfigStore } from './upload-config';
import { useMediaPlaybackStore } from './mediaPlayback';

describe('登出清理业务 store（M7）', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
  });

  it('logout 后清空文件/目录/标签/上传规则与登录态', async () => {
    const auth = useAuthStore();
    const files = useFileStore();
    const folders = useFolderStore();
    const tags = useTagStore();
    const uploadConfig = useUploadConfigStore();

    auth.user = { id: 'u1', email: 'a@b.c', role: 'user' } as any;
    files.files = [{ id: 'f1', originalName: 'a.txt' } as any];
    files.total = 1;
    folders.tree = [{ id: 'd1', name: 'docs' } as any];
    folders.currentFolderId = 'd1';
    folders.breadcrumb = [{ id: 'd1', name: 'docs' } as any];
    tags.tags = [{ id: 't1', name: 'tag' } as any];
    uploadConfig.loaded = true;
    uploadConfig.config = { maxFileSize: 1024, fileTypeMode: 'whitelist', fileTypeFilter: ['.zip'], strictSerialUpload: true };

    await auth.logout();

    expect(auth.user).toBeNull();
    expect(files.files).toEqual([]);
    expect(files.total).toBe(0);
    expect(folders.tree).toEqual([]);
    expect(folders.currentFolderId).toBeNull();
    expect(folders.breadcrumb).toEqual([]);
    expect(tags.tags).toEqual([]);
    expect(uploadConfig.loaded).toBe(false);
    expect(uploadConfig.config.fileTypeMode).toBe('blacklist');
    expect(uploadConfig.config.maxFileSize).toBe(DEFAULT_MAX_FILE_SIZE_BYTES);
  });

  it('logout 停止媒体播放并清空会话', async () => {
    const auth = useAuthStore();
    const media = useMediaPlaybackStore();

    media.session = {
      context: { type: 'user' },
      item: { id: 'f1', name: 'v.mp4', kind: 'video' },
    } as any;
    media.expanded = false;

    await auth.logout();

    expect(media.session).toBeNull();
    expect(media.expanded).toBe(true);
  });

  it('某个 store 清理失败也不会阻断登出', async () => {
    const auth = useAuthStore();
    const files = useFileStore();
    auth.user = { id: 'u1' } as any;
    files.files = [{ id: 'f1' } as any];

    // 注入异常：reset 抛错不应影响后续清理与 auth 状态
    const filesStore = files as unknown as { reset: () => void };
    const original = filesStore.reset;
    filesStore.reset = () => {
      throw new Error('boom');
    };

    await expect(auth.logout()).resolves.toBeUndefined();

    expect(auth.user).toBeNull();
    filesStore.reset = original;
  });
});
