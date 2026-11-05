import { Readable } from 'stream';
import axios from 'axios';
import { GDriveStorageDriver } from './gdrive.driver';
import type { GDriveOAuthService } from '../gdrive-oauth.service';
import type { StorageBackendsService } from '../storage-backends.service';
import { StorageAccountContext, StorageAccountError } from '../storage.types';

jest.mock('axios', () => ({
  __esModule: true,
  default: { get: jest.fn(), post: jest.fn(), put: jest.fn(), delete: jest.fn() },
}));

const api = axios as unknown as {
  get: jest.Mock; post: jest.Mock; put: jest.Mock; delete: jest.Mock;
};

const MB = 1024 * 1024;
const GB = 1024 * MB;

function makeOAuth(): GDriveOAuthService {
  return {
    createAuthorizedClient: jest.fn(async () => ({
      getAccessToken: async () => ({ token: 'access-token' }),
    })),
    fetchQuota: jest.fn(async () => ({ totalBytes: 15 * GB, usedBytes: 1 * GB })),
  } as unknown as GDriveOAuthService;
}

function makeBackends(): StorageBackendsService {
  return { patchConfig: jest.fn().mockResolvedValue(undefined) } as unknown as StorageBackendsService;
}

function makeCtx(overrides: Partial<StorageAccountContext> = {}): StorageAccountContext {
  return {
    accountId: 'acc-1',
    type: 'gdrive',
    config: { rootFolderId: 'root-folder-1' },
    credential: { refreshToken: 'refresh-token' },
    ...overrides,
  };
}

function driveError(status: number, reason?: string) {
  return {
    response: {
      status,
      data: reason ? { error: { errors: [{ reason }] } } : {},
    },
    message: `Request failed with status code ${status}`,
  };
}

describe('GDriveStorageDriver（mock Drive v3 REST）', () => {
  let driver: GDriveStorageDriver;
  let oauth: GDriveOAuthService;
  let backends: StorageBackendsService;

  beforeEach(() => {
    jest.clearAllMocks();
    oauth = makeOAuth();
    backends = makeBackends();
    driver = new GDriveStorageDriver(oauth, backends);
  });

  it('小文件（<=5MB）走 multipart：元数据+字节一体提交，返回 fileId', async () => {
    api.post.mockResolvedValue({ data: { id: 'file-small', size: '4' } });
    const result = await driver.upload(makeCtx(), {
      objectName: '照片.jpg',
      openStream: () => Readable.from([Buffer.from('data')]),
      knownLength: 4,
      mimeType: 'image/jpeg',
    });
    expect(result).toEqual({ objectRef: 'file-small', size: 4 });
    const [url, payload, options] = api.post.mock.calls[0];
    expect(url).toContain('/upload/drive/v3/files');
    expect(options.params).toMatchObject({ uploadType: 'multipart' });
    expect(options.headers.Authorization).toBe('Bearer access-token');
    const body = (payload as Buffer).toString('utf8');
    expect(body).toContain('"parents":["root-folder-1"]');
    expect(body).toContain('image/jpeg');
    expect(body).toContain('data');
    // 对象名含 uuid 前缀（覆盖上传不冲突）+ sanitize 后的展示名
    expect(body).toMatch(/"name":"[0-9a-f-]{36}-照片\.jpg"/);
  });

  it('大文件（>5MB）走 resumable：initiate → 分块 PUT（Content-Range 正确）', async () => {
    api.post.mockResolvedValue({ headers: { location: 'https://session.example/upload' } });
    api.put.mockResolvedValue({ status: 200, data: { id: 'file-big', size: String(6 * MB) } });
    const bytes = Buffer.alloc(6 * MB, 7);
    const result = await driver.upload(makeCtx(), {
      objectName: 'big.bin',
      openStream: () => Readable.from([bytes]),
      knownLength: 6 * MB,
    });
    expect(result.objectRef).toBe('file-big');
    expect(api.post.mock.calls[0][2].params.uploadType).toBe('resumable');
    expect(api.post.mock.calls[0][2].headers['X-Upload-Content-Length']).toBe(String(6 * MB));
    const [sessionUri, chunk, options] = api.put.mock.calls[0];
    expect(sessionUri).toBe('https://session.example/upload');
    expect((chunk as Buffer).length).toBe(6 * MB);
    expect(options.headers['Content-Range']).toBe(`bytes 0-${6 * MB - 1}/${6 * MB}`);
  });

  it('resumable 308 续传：按服务端 Range 头同步偏移，多块顺序上传', async () => {
    api.post.mockResolvedValue({ headers: { location: 'https://session/2' } });
    api.put
      .mockResolvedValueOnce({ status: 308, headers: { range: `bytes=0-${8 * MB - 1}` }, data: {} })
      .mockResolvedValueOnce({ status: 201, data: { id: 'file-multi', size: String(16 * MB) } });
    const bytes = Buffer.alloc(16 * MB, 1);
    const result = await driver.upload(makeCtx(), {
      objectName: 'multi.bin',
      openStream: () => Readable.from([bytes]),
      knownLength: 16 * MB,
    });
    expect(result.objectRef).toBe('file-multi');
    expect(api.put).toHaveBeenCalledTimes(2);
    expect(api.put.mock.calls[0][2].headers['Content-Range']).toBe(`bytes 0-${8 * MB - 1}/${16 * MB}`);
    expect(api.put.mock.calls[1][2].headers['Content-Range']).toBe(`bytes ${8 * MB}-${16 * MB - 1}/${16 * MB}`);
  });

  it('resumable 块级重试：5xx 重试同一块（不重传整个文件）', async () => {
    api.post.mockResolvedValue({ headers: { location: 'https://session/3' } });
    api.put
      .mockRejectedValueOnce(driveError(503))
      .mockResolvedValueOnce({ status: 200, data: { id: 'file-retry', size: String(6 * MB) } });
    const result = await driver.upload(makeCtx(), {
      objectName: 'retry.bin',
      openStream: () => Readable.from([Buffer.alloc(6 * MB)]),
      knownLength: 6 * MB,
    });
    expect(result.objectRef).toBe('file-retry');
    expect(api.put).toHaveBeenCalledTimes(2);
    // 重试的是同一块（相同 Content-Range）
    expect(api.put.mock.calls[0][2].headers['Content-Range']).toEqual(api.put.mock.calls[1][2].headers['Content-Range']);
  }, 15_000);

  it('错误分类：storageQuotaExceeded→quota，rateLimitExceeded→flood（带 Retry-After）', async () => {
    api.post.mockResolvedValue({ headers: { location: 'https://session/4' } });
    api.put.mockRejectedValue(driveError(403, 'storageQuotaExceeded'));
    await expect(driver.upload(makeCtx(), {
      objectName: 'f', openStream: () => Readable.from([Buffer.alloc(6 * MB)]), knownLength: 6 * MB,
    })).rejects.toMatchObject({ kind: 'quota' });

    api.put.mockRejectedValue(driveError(403, 'userRateLimitExceeded'));
    await expect(driver.upload(makeCtx(), {
      objectName: 'f', openStream: () => Readable.from([Buffer.alloc(6 * MB)]), knownLength: 6 * MB,
    })).rejects.toMatchObject({ kind: 'flood', retryAfterSeconds: 60 });
  });

  it('invalid_grant（refresh_token 失效）→ auth 类失败', async () => {
    (oauth.createAuthorizedClient as jest.Mock).mockResolvedValue({
      getAccessToken: async () => { throw new Error('invalid_grant: Token has been expired or revoked.'); },
    });
    await expect(driver.upload(makeCtx(), {
      objectName: 'f', openStream: () => Readable.from([]), knownLength: 1,
    })).rejects.toMatchObject({ kind: 'auth' });
  });

  it('abort：resumable 会话被 DELETE 清理（不留残留会话）', async () => {
    api.post.mockResolvedValue({ headers: { location: 'https://session/abort' } });
    api.delete.mockResolvedValue({});
    const controller = new AbortController();
    controller.abort();
    await expect(driver.upload(makeCtx(), {
      objectName: 'f',
      openStream: () => Readable.from([Buffer.alloc(6 * MB)]),
      knownLength: 6 * MB,
      signal: controller.signal,
    })).rejects.toBeInstanceOf(StorageAccountError);
    expect(api.delete).toHaveBeenCalledWith('https://session/abort', expect.anything());
    expect(api.put).not.toHaveBeenCalled();
  });

  it('根文件夹：config 缺失时查找/创建 TGTC/ 并回填 patchConfig', async () => {
    api.get.mockResolvedValueOnce({ data: { files: [] } }); // files 查询无结果
    api.post
      .mockResolvedValueOnce({ data: { id: 'created-folder' } }) // 创建文件夹
      .mockResolvedValueOnce({ data: { id: 'file-x', size: '1' } }); // multipart 上传
    const ctx = makeCtx({ config: {} });
    const result = await driver.upload(ctx, {
      objectName: 'f', openStream: () => Readable.from([Buffer.from('x')]), knownLength: 1,
    });
    expect(result.objectRef).toBe('file-x');
    expect(backends.patchConfig).toHaveBeenCalledWith('acc-1', { rootFolderId: 'created-folder' });
    expect((ctx.config as { rootFolderId?: string }).rootFolderId).toBe('created-folder');
    // 创建请求的 mimeType 是文件夹
    expect(api.post.mock.calls[0][1]).toMatchObject({
      name: 'TGTC',
      mimeType: 'application/vnd.google-apps.folder',
    });
  });

  it('下载：alt=media + Range 透传，Content-Range 解析总大小', async () => {
    const stream = Readable.from(['part']);
    api.get.mockResolvedValue({
      data: stream,
      headers: { 'content-range': 'bytes 100-199/1234', 'content-length': '100' },
    });
    const result = await driver.openDownloadStream(makeCtx(), { objectRef: 'file-1', range: { start: 100, end: 199 } });
    expect(result.stream).toBe(stream);
    expect(result.size).toBe(1234);
    const [url, options] = api.get.mock.calls[0];
    expect(url).toContain('/drive/v3/files/file-1');
    expect(options.params).toMatchObject({ alt: 'media' });
    expect(options.headers.Range).toBe('bytes=100-199');
    expect(options.responseType).toBe('stream');
  });

  it('head：trashed/404 → exists=false；正常返回大小', async () => {
    api.get.mockResolvedValueOnce({ data: { size: '10', trashed: true } });
    expect(await driver.headObject(makeCtx(), 'f')).toEqual({ exists: false });
    api.get.mockRejectedValueOnce(driveError(404));
    expect(await driver.headObject(makeCtx(), 'f')).toEqual({ exists: false });
    api.get.mockResolvedValueOnce({ data: { size: '10', trashed: false } });
    expect(await driver.headObject(makeCtx(), 'f')).toEqual({ exists: true, size: 10 });
  });

  it('删除：files.delete；404 幂等成功', async () => {
    api.delete.mockResolvedValueOnce({});
    await driver.deleteObject(makeCtx(), 'file-1');
    expect(api.delete.mock.calls[0][0]).toContain('/drive/v3/files/file-1');
    api.delete.mockRejectedValueOnce(driveError(404));
    await expect(driver.deleteObject(makeCtx(), 'file-1')).resolves.toBeUndefined();
  });

  it('probe 与 getQuota：about.get 探活；配额委托 OAuth 服务（15GB 个人账号）', async () => {
    api.get.mockResolvedValueOnce({ data: { storageQuota: {} } });
    expect((await driver.probeAccount(makeCtx())).ok).toBe(true);
    const quota = await driver.getQuota!(makeCtx());
    expect(quota).toEqual({ totalBytes: 15 * GB, usedBytes: 1 * GB });
    expect(oauth.fetchQuota).toHaveBeenCalled();
  });
});