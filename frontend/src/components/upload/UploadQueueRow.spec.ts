// @vitest-environment jsdom
import { mount } from '@vue/test-utils';
import { describe, expect, it, vi, afterEach } from 'vitest';
import UploadQueueRow from './UploadQueueRow.vue';
import type { QueueEntry } from '@/stores/upload';

/**
 * A-20：确定性失败（类型/大小/同名冲突）原样重传必然再失败。
 * 此前所有终态失败都只显示「失败」+ 原因，用户无法判断该不该重传。
 * 这里锁定：retryable === false 才降级为「不可重传」，缺省与 true 保持既有行为。
 */

function entry(overrides: Partial<QueueEntry> = {}): QueueEntry {
  return {
    uid: 'u-1',
    file: null,
    fileName: 'a.mp4',
    mimeType: 'video/mp4',
    status: 'error',
    errorReason: '不支持的文件类型',
    progress: 0,
    totalBytes: 1024,
    loadedBytes: 0,
    speed: '-',
    eta: '-',
    checkpointTime: 0,
    checkpointBytes: 0,
    speedBps: 0,
    folderId: null,
    tagIds: [],
    ...overrides,
  };
}

function mountRow(e: QueueEntry, allowPreview = false) {
  return mount(UploadQueueRow, {
    props: { entry: e, allowPreview },
    global: {
      stubs: {
        't-tag': { props: ['theme'], template: '<span class="tag-stub" :data-theme="theme"><slot /></span>' },
        't-button': { template: '<button class="btn-stub"><slot /></button>' },
        't-progress': { template: '<div class="progress-stub" />' },
        FileTypeIcon: { template: '<i class="file-icon-stub" />' },
      },
    },
  });
}

afterEach(() => vi.restoreAllMocks());

describe('UploadQueueRow 失败可重传语义（A-20）', () => {
  it('确定性失败标记为「不可重传」并提示需调整后重新上传', () => {
    const wrapper = mountRow(entry({ retryable: false }));
    const tag = wrapper.get('.tag-stub');
    expect(tag.text()).toBe('不可重传');
    expect(tag.attributes('data-theme')).toBe('danger');
    expect(wrapper.get('.upload-queue-row__error').text()).toBe('不支持的文件类型（需调整后重新上传）');
  });

  it('瞬时故障仍显示「失败」，原因文案不加确定性提示', () => {
    const wrapper = mountRow(entry({ retryable: true, errorReason: '网络中断' }));
    expect(wrapper.get('.tag-stub').text()).toBe('失败');
    expect(wrapper.get('.upload-queue-row__error').text()).toBe('网络中断');
  });

  it('retryable 缺省时按可重试处理（兼容未带该字段的旧数据）', () => {
    const wrapper = mountRow(entry({ errorReason: '服务端错误' }));
    expect(wrapper.get('.tag-stub').text()).toBe('失败');
    expect(wrapper.get('.upload-queue-row__error').text()).toBe('服务端错误');
  });

  it('title 与可见文案一致，截断后仍可读到完整提示', () => {
    const wrapper = mountRow(entry({ retryable: false }));
    const error = wrapper.get('.upload-queue-row__error');
    expect(error.attributes('title')).toBe(error.text());
  });

  it('非失败态不受影响：成功仍显示「成功」且不渲染错误行', () => {
    const wrapper = mountRow(entry({ status: 'success', retryable: false, errorReason: undefined }));
    expect(wrapper.get('.tag-stub').text()).toBe('成功');
    expect(wrapper.find('.upload-queue-row__error').exists()).toBe(false);
  });
});

describe('UploadQueueRow 预览 objectURL 生命周期', () => {
  it('卸载时释放预览 objectURL，避免列表滚动后内存泄漏', () => {
    const create = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:preview');
    const revoke = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
    const file = new File(['x'], 'a.png', { type: 'image/png' });
    const wrapper = mountRow(entry({ status: 'processing', file, mimeType: 'image/png', errorReason: undefined }), true);

    expect(create).toHaveBeenCalledWith(file);
    expect(wrapper.get('.upload-queue-row__preview').attributes('src')).toBe('blob:preview');

    wrapper.unmount();
    expect(revoke).toHaveBeenCalledWith('blob:preview');
  });

  it('未开启预览时不创建 objectURL', () => {
    const create = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:preview');
    const file = new File(['x'], 'a.png', { type: 'image/png' });
    mountRow(entry({ status: 'processing', file, mimeType: 'image/png', errorReason: undefined }), false);
    expect(create).not.toHaveBeenCalled();
  });
});