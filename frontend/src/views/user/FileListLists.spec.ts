// @vitest-environment jsdom
import { mount } from '@vue/test-utils';
import { describe, expect, it, vi } from 'vitest';

// ThumbnailImg / utils 链路间接引入 TDesign 子路径（裸 .css，Node 侧不可直接加载）
vi.mock('tdesign-vue-next/es/message', () => ({
  MessagePlugin: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() },
}));
vi.mock('tdesign-vue-next/es/dialog', () => ({
  DialogPlugin: { confirm: vi.fn(), alert: vi.fn(), info: vi.fn(), warning: vi.fn() },
}));

import FileListDesktopRows from './FileListDesktopRows.vue';
import FileListMobileList from './FileListMobileList.vue';
import type { FileItem } from '../../types/file';
import type { Folder } from '../../stores/folders';

/**
 * M6 拆分回归：桌面行视图与移动端列表从 FileList.vue 拆出后，
 * 渲染条件、无障碍属性与事件契约必须与拆分前一致（含移动端点击不直接进目录的语义）。
 */

const stubs = {
  't-icon': { template: '<i class="icon-stub" />' },
  't-button': {
    props: ['disabled'],
    template: '<button class="btn-stub" :disabled="disabled"><slot /></button>',
  },
  't-tag': { template: '<span class="tag-stub"><slot /></span>' },
  't-checkbox': {
    props: ['checked', 'indeterminate', 'disabled'],
    emits: ['change'],
    template: '<span class="checkbox-stub" @click="$emit(\'change\')"><slot /></span>',
  },
  ThumbnailImg: { template: '<span class="thumb-stub" />' },
};

function fileItem(overrides: Partial<FileItem> = {}): FileItem {
  return {
    id: 'f1',
    originalName: 'report.pdf',
    mimeType: 'application/pdf',
    size: 2048,
    status: 'ready',
    isDeleted: false,
    deletedByAdmin: false,
    deleteRequestedAt: null,
    hasPassword: false,
    accessType: 'private',
    uploadVersion: 1,
    createdAt: '2026-09-10T10:00:00.000Z',
    tags: [],
    ...overrides,
  } as unknown as FileItem;
}

const folderItem = (id: string, name: string, children = 0): Folder => ({
  id,
  name,
  createdAt: '2026-09-10T10:00:00.000Z',
  children: Array.from({ length: children }, (_, i) => ({ id: `c${i}` })),
}) as unknown as Folder;

describe('FileListDesktopRows（M6 拆分契约）', () => {
  function mountRows(overrides: Record<string, unknown> = {}) {
    return mount(FileListDesktopRows, {
      props: {
        subfolders: [],
        files: [],
        selectedIds: [],
        isAllSelected: false,
        isIndeterminate: false,
        busy: false,
        sortBy: 'createdAt',
        sortOrder: 'DESC',
        dragOverFolderId: null,
        draggingFileIds: [],
        thumbnailContext: 'u:1',
        ...overrides,
      },
      global: { stubs },
    });
  }

  it('表头按当前排序列输出 aria-sort，点击表头回传字段名', async () => {
    const wrapper = mountRows({ sortBy: 'originalName', sortOrder: 'ASC' });
    const headers = wrapper.findAll('.os-sort-btn');

    expect(headers[0]!.attributes('aria-sort')).toBe('ascending');
    expect(headers[1]!.attributes('aria-sort')).toBe('none');

    await headers[0]!.trigger('click');
    await headers[1]!.trigger('click');

    expect(wrapper.emitted('toggle-sort')).toEqual([['originalName'], ['createdAt']]);
  });

  it('全选框回传 toggle-select-all', async () => {
    const wrapper = mountRows({ isAllSelected: true, isIndeterminate: true });

    expect(wrapper.find('.os-head .checkbox-stub').exists()).toBe(true);

    await wrapper.get('.os-head .checkbox-stub').trigger('click');
    expect(wrapper.emitted('toggle-select-all')).toEqual([[]]);
  });

  it('文件夹行渲染子项数量并支持进入、拖放与拖拽悬停高亮', async () => {
    const folder = folderItem('d1', '文档', 3);
    const wrapper = mountRows({ subfolders: [folder], dragOverFolderId: 'd1' });
    const row = wrapper.get('.os-folder');

    expect(row.classes()).toContain('drag-over');
    expect(row.text()).toContain('3 项');

    await row.trigger('dblclick');
    await row.trigger('dragover');
    await row.trigger('dragleave');
    await row.trigger('drop');

    expect(wrapper.emitted('folder-open')).toEqual([[folder]]);
    expect(wrapper.emitted('folder-drag-over')?.[0]?.[1]).toBe('d1');
    expect(wrapper.emitted('folder-drag-leave')?.[0]?.[1]).toBe('d1');
    expect(wrapper.emitted('drop-on-folder')?.[0]?.[1]).toBe('d1');
  });

  it('文件行按状态/删除态输出行类名与可操作性属性', () => {
    const wrapper = mountRows({
      files: [
        fileItem({ id: 'a', status: 'processing' }),
        fileItem({ id: 'b', isDeleted: true }),
        fileItem({ id: 'c' }),
      ],
      draggingFileIds: ['c'],
    });
    const rows = wrapper.findAll('.os-file');

    expect(rows[0]!.classes()).toContain('row-processing');
    expect(rows[0]!.attributes('draggable')).toBe('false');
    expect(rows[0]!.attributes('tabindex')).toBe('-1');

    expect(rows[1]!.classes()).toContain('row-deleted');

    expect(rows[2]!.classes()).toContain('dragging');
    expect(rows[2]!.attributes('draggable')).toBe('true');
    expect(rows[2]!.attributes('tabindex')).toBe('0');
    expect(rows[2]!.attributes('role')).toBe('button');
    expect(rows[2]!.attributes('aria-label')).toBe('下载 report.pdf');
  });

  it('已删除文件名带删除线样式类', () => {
    const wrapper = mountRows({ files: [fileItem({ isDeleted: true })] });

    expect(wrapper.get('.os-name-text').classes()).toContain('deleted-name');
  });

  it('文件行交互回传事件：选择 / 下载 / 预览 / 标签筛选 / 拖拽', async () => {
    const file = fileItem({ tags: [{ id: 't1', name: '报表', color: '#fff' }] as never });
    const wrapper = mountRows({ files: [file] });

    await wrapper.get('.os-file .checkbox-stub').trigger('click');
    await wrapper.get('.os-file').trigger('dblclick');
    // 可预览类型：缩略图外层为预览热区（阻止冒泡）
    await wrapper.get('.os-thumb-click').trigger('click');
    await wrapper.get('.os-tag-click').trigger('click');
    await wrapper.get('.os-file').trigger('dragstart');
    await wrapper.get('.os-file').trigger('dragend');

    expect(wrapper.emitted('file-select')).toEqual([[file]]);
    // 仅双击文件行触发下载（缩略图热区为预览且已阻止冒泡）
    expect(wrapper.emitted('download')).toEqual([[file]]);
    expect(wrapper.emitted('preview')).toEqual([[file]]);
    expect(wrapper.emitted('tag-filter')).toEqual([['t1']]);
    expect(wrapper.emitted('file-drag-start')).toEqual([[expect.anything(), file]]);
    expect(wrapper.emitted('file-drag-end')).toEqual([[]]);
  });

  it('不可预览类型不渲染预览热区，缩略图仍展示', () => {
    const wrapper = mountRows({ files: [fileItem({ mimeType: 'application/zip', originalName: 'a.zip' })] });

    expect(wrapper.find('.os-thumb-click').exists()).toBe(false);
    expect(wrapper.find('.thumb-stub').exists()).toBe(true);
  });
});

describe('FileListMobileList（M6 拆分契约）', () => {
  function mountMobile(overrides: Record<string, unknown> = {}) {
    return mount(FileListMobileList, {
      props: {
        subfolders: [],
        files: [],
        selectableCount: 0,
        selectedIds: [],
        isAllSelected: false,
        isIndeterminate: false,
        busy: false,
        isAdmin: false,
        thumbnailContext: 'u:1',
        ...overrides,
      },
      global: { stubs },
    });
  }

  it('无可操作文件时不渲染全选工具栏', () => {
    expect(mountMobile().find('.mobile-selection-toolbar').exists()).toBe(false);

    const wrapper = mountMobile({ selectableCount: 2, selectedIds: ['f1'] });
    expect(wrapper.get('.mobile-selection-toolbar').text()).toContain('全选当前已加载的 2 个可操作文件');
    expect(wrapper.get('.mobile-selection-count').text()).toBe('已选 1 项');
  });

  it('文件夹行点击只回传 folder-click（长按抑制判定留在宿主）', async () => {
    const folder = folderItem('d1', '文档');
    const wrapper = mountMobile({ subfolders: [folder] });

    await wrapper.get('.mobile-folder-row').trigger('click');

    expect(wrapper.emitted('folder-click')).toEqual([[folder]]);
    expect(wrapper.emitted('folder-open')).toBeUndefined();
  });

  it('文件夹行与卡片的长按触摸事件原样回传类型与目标', async () => {
    const folder = folderItem('d1', '文档');
    const file = fileItem();
    const wrapper = mountMobile({ subfolders: [folder], files: [file] });

    await wrapper.get('.mobile-folder-row').trigger('touchstart');
    await wrapper.get('.mobile-folder-row').trigger('touchmove');
    await wrapper.get('.mobile-folder-row').trigger('touchend');
    await wrapper.get('.mobile-file-card').trigger('touchstart');

    expect(wrapper.emitted('touch-start')?.[0]?.[1]).toBe('folder');
    expect(wrapper.emitted('touch-start')?.[0]?.[2]).toEqual(folder);
    expect(wrapper.emitted('touch-move')).toHaveLength(1);
    expect(wrapper.emitted('touch-end')).toHaveLength(1);
    expect(wrapper.emitted('touch-start')?.[1]?.[1]).toBe('file');
    expect(wrapper.emitted('touch-start')?.[1]?.[2]).toEqual(file);
  });

  it('正常文件卡片提供复制/预览/下载/标签/删除五个动作', async () => {
    const file = fileItem();
    const wrapper = mountMobile({ files: [file], selectedIds: ['f1'] });
    const buttons = wrapper.findAll('.mobile-file-card-actions .btn-stub');

    expect(buttons).toHaveLength(5);

    await wrapper.get('.mobile-file-select').trigger('click');
    await buttons[0]!.trigger('click');
    await buttons[1]!.trigger('click');
    await buttons[2]!.trigger('click');
    await buttons[3]!.trigger('click');
    await buttons[4]!.trigger('click');

    expect(wrapper.emitted('file-select')).toEqual([[file]]);
    expect(wrapper.emitted('copy-link')).toEqual([[file]]);
    expect(wrapper.emitted('preview')).toEqual([[file]]);
    expect(wrapper.emitted('download')).toEqual([[file]]);
    expect(wrapper.emitted('tag-editor')).toEqual([[file]]);
    expect(wrapper.emitted('delete')).toEqual([[file]]);
  });

  it('仅展示前两个标签并给出剩余数量', () => {
    const file = fileItem({
      tags: [
        { id: 't1', name: 'A', color: '#111' },
        { id: 't2', name: 'B', color: '#222' },
        { id: 't3', name: 'C', color: '#333' },
      ] as never,
    });
    const wrapper = mountMobile({ files: [file] });

    expect(wrapper.findAll('.mobile-file-tags .tag-stub')).toHaveLength(3);
    expect(wrapper.get('.mobile-tag-more').text()).toBe('+1');

    expect(wrapper.findAll('.os-tag-click')).toHaveLength(2);
  });

  it('已删除文件卡片：管理员展示恢复+强制删除', async () => {
    const file = fileItem({ isDeleted: true, deletedByAdmin: true });
    const wrapper = mountMobile({ files: [file], isAdmin: true });
    const buttons = wrapper.findAll('.mobile-file-card-actions .btn-stub');

    expect(buttons).toHaveLength(2);
    // 被管理员删除的文件，非管理员禁用恢复（此处为管理员 → 可恢复）
    expect(buttons[0]!.attributes('disabled')).toBeUndefined();

    await buttons[0]!.trigger('click');
    await buttons[1]!.trigger('click');

    expect(wrapper.emitted('restore')).toEqual([['f1']]);
    expect(wrapper.emitted('force-delete')).toEqual([['f1']]);
  });

  it('已删除文件卡片：非管理员在冷静期未满时不展示永久删除', () => {
    const fresh = mountMobile({
      files: [fileItem({ isDeleted: true, deleteRequestedAt: new Date().toISOString() })],
      isAdmin: false,
    });
    expect(fresh.findAll('.mobile-file-card-actions .btn-stub')).toHaveLength(1);

    const ready = mountMobile({
      files: [fileItem({
        isDeleted: true,
        deleteRequestedAt: new Date(Date.now() - 120_000).toISOString(),
      })],
      isAdmin: false,
    });
    const buttons = ready.findAll('.mobile-file-card-actions .btn-stub');
    expect(buttons).toHaveLength(2);
    expect(buttons[1]!.text()).toContain('永久删除');
  });
});
