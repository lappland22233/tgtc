import { describe, expect, it } from 'vitest';
import {
  classifyServiceAvailabilityError,
  getApiErrorDetails,
  getDownloadError,
  getDownloadErrorMessage,
  getErrorMessage,
  getUploadBudgetRetryAfterMs,
  isUploadBudgetBusy,
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

  it('顶层 code 为数字 HTTP 状态时提取 errorCode 中的业务码', () => {
    const error = {
      response: {
        status: 429,
        data: { code: 429, errorCode: 'UPLOAD_DISK_BUDGET_BUSY', message: '排队中' },
      },
    };

    expect(getApiErrorDetails(error)).toEqual({
      status: 429,
      code: 'UPLOAD_DISK_BUDGET_BUSY',
      message: '排队中',
    });
  });

  it('无业务码但文案含磁盘的响应（代理/防御性形状）仍归类为存储空间不足', () => {
    // 注意：本仓库后端自产 5xx 的 message 会被全局过滤器覆写为「服务器内部错误」，
    // 因此该形状只能来自代理/其它后端；保留它作为防御性兜底，不代表我方后端契约。
    const proxied = { response: { status: 500, data: { message: '磁盘空间不足' } } };

    expect(classifyServiceAvailabilityError(proxied)?.kind).toBe('storage_full');
    expect(getErrorMessage(proxied)).toContain('存储空间不足');
  });

  it('合并期的磁盘失败是裸 Error（无 response）：不做全局磁盘归类，原样展示后端文案', () => {
    // 真实通道：合并阶段 ensureDiskSpace 失败写入 mergeError，前端经轮询 200 体拿到后
    // 由 createMergeBusinessError 造裸 Error；裸 Error 无 response，归类依据为空。
    const mergeFailure = new Error('上传临时磁盘空间不足，请稍后重试');

    expect(classifyServiceAvailabilityError(mergeFailure)).toBeNull();
    expect(getErrorMessage(mergeFailure)).toBe('上传临时磁盘空间不足，请稍后重试');
  });
});

describe('上传磁盘预算排队识别', () => {
  it('顶层 code 为数字 429 + errorCode 时不归类为基础设施故障，且保留后端文案', () => {
    const error = {
      response: {
        status: 429,
        headers: { 'x-tgtc-error-code': 'UPLOAD_DISK_BUDGET_BUSY', 'retry-after': '5' },
        data: {
          code: 429,
          errorCode: 'UPLOAD_DISK_BUDGET_BUSY',
          retryAfterMs: 5000,
          message: '服务器正在依次处理另一份大文件，本文件已自动排队，请保持页面打开',
        },
      },
    };

    expect(classifyServiceAvailabilityError(error)).toBeNull();
    expect(getErrorMessage(error)).toBe('服务器正在依次处理另一份大文件，本文件已自动排队，请保持页面打开');
  });

  it('旧版后端「保留磁盘空间」文案同样不被误报为磁盘不足', () => {
    const error = {
      response: {
        status: 429,
        data: { code: 429, errorCode: 'UPLOAD_DISK_BUDGET_BUSY', message: '服务器正在为另一份大文件保留磁盘空间，请保持本页打开后稍候重试' },
      },
    };

    expect(classifyServiceAvailabilityError(error)).toBeNull();
    expect(getErrorMessage(error)).toContain('保留磁盘空间');
  });

  it.each([
    ['响应体业务码', { response: { data: { errorCode: 'UPLOAD_DISK_BUDGET_BUSY' } } }],
    ['历史 code 写法', { response: { data: { code: 'UPLOAD_DISK_BUDGET_BUSY' } } }],
    ['响应头兜底', { response: { data: {}, headers: { 'X-Tgtc-Error-Code': 'UPLOAD_DISK_BUDGET_BUSY' } } }],
  ])('isUploadBudgetBusy 识别 %s', (_label, shape) => {
    expect(isUploadBudgetBusy(shape)).toBe(true);
  });

  it('拦截器包装后的 cause 链仍可识别', () => {
    const cause = { response: { status: 429, data: { errorCode: 'UPLOAD_DISK_BUDGET_BUSY', retryAfterMs: 5000 } } };
    const wrapped = Object.assign(new Error('包装后的错误'), { cause });

    expect(isUploadBudgetBusy(wrapped)).toBe(true);
    expect(getUploadBudgetRetryAfterMs(wrapped)).toBe(5000);
  });

  it('等待间隔取响应体 retryAfterMs，缺失时回退 Retry-After 头', () => {
    expect(getUploadBudgetRetryAfterMs({
      response: { data: { errorCode: 'UPLOAD_DISK_BUDGET_BUSY', retryAfterMs: 3000 } },
    })).toBe(3000);
    expect(getUploadBudgetRetryAfterMs({
      response: { data: { errorCode: 'UPLOAD_DISK_BUDGET_BUSY' }, headers: { 'retry-after': '7' } },
    })).toBe(7000);
    // 非法值（过小/不可解析）回退默认 5s
    expect(getUploadBudgetRetryAfterMs({
      response: { data: { errorCode: 'UPLOAD_DISK_BUDGET_BUSY', retryAfterMs: 10 } },
    })).toBe(5000);
    // 服务端要求更长的间隔时只做上限收敛（夹到 60s），不塌回 5s 造成无谓轮询
    expect(getUploadBudgetRetryAfterMs({
      response: { data: { errorCode: 'UPLOAD_DISK_BUDGET_BUSY', retryAfterMs: 300_000 } },
    })).toBe(60_000);
    expect(getUploadBudgetRetryAfterMs({
      response: { data: { errorCode: 'UPLOAD_DISK_BUDGET_BUSY' }, headers: { 'retry-after': '120' } },
    })).toBe(60_000);
  });

  it('首个排队节点未带间隔时继续沿 cause 链取值', () => {
    const inner = { response: { data: { errorCode: 'UPLOAD_DISK_BUDGET_BUSY', retryAfterMs: 7000 } } };
    const outer = { response: { data: { errorCode: 'UPLOAD_DISK_BUDGET_BUSY' } }, cause: inner };

    expect(getUploadBudgetRetryAfterMs(outer)).toBe(7000);
  });

  it('非排队类错误返回 null，交由常规瞬时错误处理', () => {
    expect(isUploadBudgetBusy({ response: { status: 429, data: { message: '上传请求过多' } } })).toBe(false);
    expect(getUploadBudgetRetryAfterMs({ response: { status: 503, data: {} } })).toBeNull();
    expect(getUploadBudgetRetryAfterMs(new Error('Network Error'))).toBeNull();
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

  it('真实线格式（顶层 code 为数字 507、业务码在 errorCode）同样命中下载专属文案', () => {
    const error = {
      response: {
        status: 507,
        headers: { 'x-tgtc-error-code': 'DOWNLOAD_INSUFFICIENT_STORAGE' },
        data: { code: 507, errorCode: 'DOWNLOAD_INSUFFICIENT_STORAGE', message: '服务器可用空间不足，无法完整暂存该文件' },
      },
    };

    // 全局过滤器恒把顶层 code 写成 HTTP 状态码，业务码只在 errorCode：
    // 该用例钉住「业务码优先提取」这一契约，避免退回 legacy 形状后失效。
    expect(classifyServiceAvailabilityError(error)).toBeNull();
    expect(getDownloadError(error)?.code).toBe('DOWNLOAD_INSUFFICIENT_STORAGE');
    expect(getDownloadErrorMessage(error)).toBe('服务器存储空间不足，暂时无法准备此文件');
  });

  it('非下载类错误不产生下载文案', () => {
    expect(getDownloadError({ response: { status: 500, data: { code: 'SOMETHING_ELSE' } } })).toBeNull();
    expect(getDownloadErrorMessage({ response: { status: 500, data: {} } })).toBeUndefined();
  });
});
