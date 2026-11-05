import { Readable } from 'stream';
import { S3Client } from '@aws-sdk/client-s3';
import { S3StorageDriver } from './s3.driver';
import { StorageAccountContext, StorageAccountError } from '../storage.types';

const mockSend = jest.fn();
const mockDestroy = jest.fn();
const mockUploadDone = jest.fn();
const mockUploadAbort = jest.fn().mockResolvedValue(undefined);
let lastUploadOptions: Record<string, unknown> | null = null;

jest.mock('@aws-sdk/client-s3', () => ({
  S3Client: jest.fn().mockImplementation(() => ({ send: mockSend, destroy: mockDestroy })),
  GetObjectCommand: jest.fn().mockImplementation((input) => ({ input, command: 'GetObject' })),
  HeadObjectCommand: jest.fn().mockImplementation((input) => ({ input, command: 'HeadObject' })),
  DeleteObjectCommand: jest.fn().mockImplementation((input) => ({ input, command: 'DeleteObject' })),
  HeadBucketCommand: jest.fn().mockImplementation((input) => ({ input, command: 'HeadBucket' })),
}));

jest.mock('@aws-sdk/lib-storage', () => ({
  Upload: jest.fn().mockImplementation((options) => {
    lastUploadOptions = options;
    return { done: mockUploadDone, abort: mockUploadAbort };
  }),
}));

function makeCtx(overrides: Partial<StorageAccountContext> = {}): StorageAccountContext {
  return {
    accountId: 'acc-1',
    type: 's3',
    config: { bucket: 'test-bucket', region: 'us-east-1', prefix: 'tgtc', forcePathStyle: true },
    credential: { accessKeyId: 'AKIAEXAMPLE', secretAccessKey: 'secret' },
    ...overrides,
  };
}

describe('S3StorageDriver（mock AWS SDK）', () => {
  let driver: S3StorageDriver;

  beforeEach(() => {
    jest.clearAllMocks();
    lastUploadOptions = null;
    driver = new S3StorageDriver();
  });

  it('上传：分片 Upload 配置正确（桶/前缀键/失败清理分片），返回对象引用', async () => {
    mockUploadDone.mockResolvedValue({});
    const result = await driver.upload(makeCtx(), {
      objectName: '报表.xlsx',
      openStream: () => Readable.from(['data']),
      knownLength: 4,
      mimeType: 'application/vnd.ms-excel',
    });
    expect(result.objectRef.startsWith('tgtc/')).toBe(true);
    expect(result.objectRef.endsWith('-报表.xlsx')).toBe(true);
    expect(result.size).toBe(4);
    const options = lastUploadOptions as { params: Record<string, unknown>; leavePartsOnError: boolean };
    expect(options.params.Bucket).toBe('test-bucket');
    expect(options.params.Key).toBe(result.objectRef);
    expect(options.params.ContentType).toBe('application/vnd.ms-excel');
    // 失败必须清理残留分片（避免桶内计费对象泄漏）
    expect(options.leavePartsOnError).toBe(false);
  });

  it('上传：无 prefix 时键不带前导斜杠；对象键含 uuid 保证覆盖不冲突', async () => {
    mockUploadDone.mockResolvedValue({});
    const ctx = makeCtx({ config: { bucket: 'b', region: 'r' } });
    const a = await driver.upload(ctx, { objectName: 'f.bin', openStream: () => Readable.from([]), knownLength: 0 });
    const b = await driver.upload(ctx, { objectName: 'f.bin', openStream: () => Readable.from([]), knownLength: 0 });
    expect(a.objectRef.startsWith('/')).toBe(false);
    expect(a.objectRef).not.toEqual(b.objectRef);
  });

  it('上传：abort 信号触发分片会话 abort 并销毁流', async () => {
    const controller = new AbortController();
    let aborted = false;
    mockUploadDone.mockImplementation(() => new Promise((_, reject) => {
      const timer = setTimeout(() => reject(new Error('timeout')), 5000);
      controller.signal.addEventListener('abort', () => {
        clearTimeout(timer);
        aborted = true;
        reject(new Error('aborted'));
      });
    }));
    const stream = Readable.from(['data']);
    const destroySpy = jest.spyOn(stream, 'destroy');
    const promise = driver.upload(makeCtx(), {
      objectName: 'f', openStream: () => stream, knownLength: 4, signal: controller.signal,
    });
    controller.abort();
    await expect(promise).rejects.toBeInstanceOf(StorageAccountError);
    expect(aborted).toBe(true);
    expect(mockUploadAbort).toHaveBeenCalled();
    expect(destroySpy).toHaveBeenCalled();
  });

  it('上传失败分类：AccessDenied→auth，SlowDown→flood，5xx→unavailable', async () => {
    mockUploadDone.mockRejectedValueOnce(Object.assign(new Error('denied'), { name: 'AccessDenied' }));
    await expect(driver.upload(makeCtx(), { objectName: 'f', openStream: () => Readable.from([]), knownLength: 0 }))
      .rejects.toMatchObject({ kind: 'auth' });

    mockUploadDone.mockRejectedValueOnce(Object.assign(new Error('slow'), { name: 'SlowDown' }));
    await expect(driver.upload(makeCtx(), { objectName: 'f', openStream: () => Readable.from([]), knownLength: 0 }))
      .rejects.toMatchObject({ kind: 'flood' });

    mockUploadDone.mockRejectedValueOnce({ name: 'InternalError', $metadata: { httpStatusCode: 500 }, message: 'oops' });
    await expect(driver.upload(makeCtx(), { objectName: 'f', openStream: () => Readable.from([]), knownLength: 0 }))
      .rejects.toMatchObject({ kind: 'unavailable' });
  });

  it('下载：Range 透传，Content-Range 解析对象总大小', async () => {
    const body = Readable.from(['partial']);
    mockSend.mockResolvedValue({ Body: body, ContentRange: 'bytes 100-199/1234', ContentLength: 100 });
    const result = await driver.openDownloadStream(makeCtx(), { objectRef: 'tgtc/x', range: { start: 100, end: 199 } });
    expect(result.stream).toBe(body);
    expect(result.size).toBe(1234);
    const command = (mockSend.mock.calls[0][0] as { input: Record<string, unknown> }).input;
    expect(command.Range).toBe('bytes=100-199');
    expect(command.Key).toBe('tgtc/x');
  });

  it('下载：无 Range 时 size=ContentLength；开放范围 end 缺省', async () => {
    mockSend.mockResolvedValue({ Body: Readable.from(['all']), ContentLength: 42 });
    const result = await driver.openDownloadStream(makeCtx(), { objectRef: 'k' });
    expect(result.size).toBe(42);
    expect((mockSend.mock.calls[0][0] as { input: Record<string, unknown> }).input.Range).toBeUndefined();

    mockSend.mockResolvedValue({ Body: Readable.from(['tail']), ContentLength: 10 });
    await driver.openDownloadStream(makeCtx(), { objectRef: 'k', range: { start: 5 } });
    expect((mockSend.mock.calls[1][0] as { input: Record<string, unknown> }).input.Range).toBe('bytes=5-');
  });

  it('head：NotFound/404 → exists=false；成功返回大小', async () => {
    mockSend.mockRejectedValueOnce(Object.assign(new Error('nf'), { name: 'NotFound' }));
    expect(await driver.headObject(makeCtx(), 'k')).toEqual({ exists: false });
    mockSend.mockResolvedValueOnce({ ContentLength: 99 });
    expect(await driver.headObject(makeCtx(), 'k')).toEqual({ exists: true, size: 99 });
  });

  it('删除：调用 DeleteObject；失败抛分类错误（路由层 best-effort 兜底）', async () => {
    mockSend.mockResolvedValueOnce({});
    await driver.deleteObject(makeCtx(), 'k');
    expect((mockSend.mock.calls[0][0] as { command: string }).command).toBe('DeleteObject');
    mockSend.mockRejectedValueOnce({ name: 'AccessDenied', message: 'denied' });
    await expect(driver.deleteObject(makeCtx(), 'k')).rejects.toMatchObject({ kind: 'auth' });
  });

  it('probe：HeadBucket 成功带延迟；失败返回脱敏错误', async () => {
    mockSend.mockResolvedValueOnce({});
    const ok = await driver.probeAccount(makeCtx());
    expect(ok.ok).toBe(true);
    expect(typeof ok.latencyMs).toBe('number');
    mockSend.mockRejectedValueOnce(Object.assign(new Error('no bucket'), { name: 'NoSuchBucket' }));
    const bad = await driver.probeAccount(makeCtx());
    expect(bad.ok).toBe(false);
    expect(bad.error).toContain('桶不存在');
  });

  it('客户端缓存：同账号同凭据复用；凭据轮换重建并销毁旧客户端', async () => {
    mockSend.mockResolvedValue({});
    await driver.probeAccount(makeCtx());
    await driver.probeAccount(makeCtx());
    expect(S3Client).toHaveBeenCalledTimes(1);
    await driver.probeAccount(makeCtx({ credential: { accessKeyId: 'NEW', secretAccessKey: 'new-secret' } }));
    expect(S3Client).toHaveBeenCalledTimes(2);
    expect(mockDestroy).toHaveBeenCalledTimes(1);
    // 自定义 endpoint / path-style 透传
    const config = (S3Client as jest.Mock).mock.calls[1][0];
    expect(config.forcePathStyle).toBe(true);
  });

  it('S3 无配额概念：不实现 getQuota（调度不启用配额因子）', () => {
    expect((driver as { getQuota?: unknown }).getQuota).toBeUndefined();
  });
});