import { describe, expect, it } from 'vitest';
import {
  classifyServiceAvailabilityError,
  getApiErrorDetails,
  getDownloadError,
  getDownloadErrorMessage,
  getErrorMessage,
} from './error';

describe('API 错误适配', () => {
  it('将 507 映射为明确的磁盘空间不足提示', () => {
    const error = { response: { status: 507, data: { message: '上传临时磁盘空间不足，请稍后重试' } } };

    expect(classifyServiceAvailabilityError(error)).toEqual({
      kind: 'storage_full',
      message: '服务器存储空间不足，文件服务暂时不可用。请稍后重试或联系管理员。',
    });
    expect(getErrorMessage(error)).toContain('存储空间不足');
  });

  it('识别 Telegram 磁盘耗尽消息，即使代理状态不是 507', () => {
    const error = {
      response: {
        status: 502,
        data: { message: 'Telegram workdir disk space exhausted; service is shutting down' },
      },
    };

    expect(classifyServiceAvailabilityError(error)?.kind).toBe('storage_full');
  });

  it.each([502, 503])('将 %s 映射为服务暂时不可用', (status) => {
    expect(classifyServiceAvailabilityError({ response: { status, data: {} } })?.kind).toBe('service_unavailable');
  });

  it('将 410 独立映射为"文件已不可用"（区别于 502/503）', () => {
    const error = { response: { status: 410, data: {} } };
    expect(classifyServiceAvailabilityError(error)).toEqual({
      kind: 'file_unavailable',
      message: '文件已不可用',
    });
    expect(getErrorMessage(error)).toBe('文件已不可用');
  });

  it('保留普通业务错误消息并兼容消息数组', () => {
    const error = { response: { status: 400, data: { code: 'VALIDATION_FAILED', message: ['邮箱无效', '密码过短'] } } };

    expect(getApiErrorDetails(error)).toEqual({
      status: 400,
      code: 'VALIDATION_FAILED',
      message: '邮箱无效；密码过短',
    });
    expect(getErrorMessage(error)).toBe('邮箱无效；密码过短');
  });
});

describe('下载调度错误码文案', () => {
  // 覆盖既有 + 新增全部 DOWNLOAD_* 业务码（含任务过期）
  const codes = [
    'DOWNLOAD_QUEUE_FULL',
    'DOWNLOAD_QUEUE_TIMEOUT',
    'DOWNLOAD_QUEUE_CANCELLED',
    'DOWNLOAD_SERVER_BUSY',
    'DOWNLOAD_STORAGE_PROBE_UNAVAILABLE',
    'DOWNLOAD_INSUFFICIENT_STORAGE',
    'DOWNLOAD_TASK_EXPIRED',
    'DOWNLOAD_SHUTTING_DOWN',
  ];

  it.each(codes)('%s 有专属可读文案', (code) => {
    const error = { response: { status: 503, data: { code } } };
    const mapped = getDownloadError(error);
    expect(mapped?.code).toBe(code);
    expect(mapped?.message).toBeTruthy();
    expect(getDownloadErrorMessage(error)).toBe(mapped?.message);
  });

  it('DOWNLOAD_* 不会被通用 503/507 文案劫持', () => {
    for (const status of [503, 507]) {
      const error = {
        response: { status, data: { code: 'DOWNLOAD_SERVER_BUSY', message: '后端原始消息' } },
      };
      // 下载类错误不做通用基础设施归类，保留后端原始文案
      expect(classifyServiceAvailabilityError(error)).toBeNull();
      expect(getErrorMessage(error)).toBe('后端原始消息');
    }
  });

  it('非下载类错误不产生下载文案', () => {
    expect(getDownloadError({ response: { status: 500, data: { code: 'SOMETHING_ELSE' } } })).toBeNull();
    expect(getDownloadErrorMessage({ response: { status: 500, data: {} } })).toBeUndefined();
  });
});
