import { describe, expect, it } from 'vitest';
import { classifyServiceAvailabilityError, getApiErrorDetails, getErrorMessage } from './error';

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
