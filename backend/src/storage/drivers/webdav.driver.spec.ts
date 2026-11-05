import { Readable } from 'stream';
import { createClient } from 'webdav';
import { WebDavStorageDriver } from './webdav.driver';
import { StorageAccountContext } from '../storage.types';

const clientMock = {
  putFileContents: jest.fn(),
  createReadStream: jest.fn(),
  stat: jest.fn(),
  exists: jest.fn(),
  deleteFile: jest.fn(),
  createDirectory: jest.fn(),
  getDirectoryContents: jest.fn(),
};

jest.mock('webdav', () => ({
  createClient: jest.fn(() => clientMock),
}));

function makeCtx(overrides: Partial<StorageAccountContext> = {}): StorageAccountContext {
  return {
    accountId: 'acc-1',
    type: 'webdav',
    config: { url: 'https://dav.example.com/remote.php/dav/files/user', rootPath: 'tgtc/media' },
    credential: { username: 'user', password: 'pass' },
    ...overrides,
  };
}

function httpError(status: number): Error & { status: number } {
  return Object.assign(new Error(`HTTP ${status}`), { status });
}

describe('WebDavStorageDriver（mock webdav 客户端）', () => {
  let driver: WebDavStorageDriver;

  beforeEach(() => {
    jest.clearAllMocks();
    driver = new WebDavStorageDriver();
  });

  it('上传：PUT 带 contentLength、不覆盖、父目录递归创建，返回路径引用', async () => {
    clientMock.createDirectory.mockResolvedValue(undefined);
    clientMock.putFileContents.mockResolvedValue(true);
    const result = await driver.upload(makeCtx(), {
      objectName: '视频.mp4',
      openStream: () => Readable.from(['data']),
      knownLength: 4,
    });
    expect(result.objectRef.startsWith('/tgtc/media/')).toBe(true);
    expect(result.objectRef.endsWith('-视频.mp4')).toBe(true);
    expect(result.size).toBe(4);
    expect(clientMock.createDirectory).toHaveBeenCalledWith('/tgtc/media', { recursive: true });
    const [path, , options] = clientMock.putFileContents.mock.calls[0];
    expect(path).toBe(result.objectRef);
    expect(options).toMatchObject({ contentLength: 4, overwrite: false });
  });

  it('上传：目录已存在（405）视为成功；PUT 未确认成功抛错', async () => {
    clientMock.createDirectory.mockRejectedValue(httpError(405));
    clientMock.putFileContents.mockResolvedValue(true);
    await expect(driver.upload(makeCtx(), { objectName: 'f', openStream: () => Readable.from([]), knownLength: 0 }))
      .resolves.toBeTruthy();

    clientMock.putFileContents.mockResolvedValue(false);
    await expect(driver.upload(makeCtx(), { objectName: 'f', openStream: () => Readable.from([]), knownLength: 0 }))
      .rejects.toMatchObject({ kind: 'other' });
  });

  it('上传失败分类：401→auth、423→unavailable、507→quota（可换号）', async () => {
    clientMock.createDirectory.mockResolvedValue(undefined);
    for (const [status, kind] of [[401, 'auth'], [423, 'unavailable'], [507, 'quota']] as const) {
      clientMock.putFileContents.mockRejectedValueOnce(httpError(status));
      await expect(driver.upload(makeCtx(), { objectName: 'f', openStream: () => Readable.from([]), knownLength: 0 }))
        .rejects.toMatchObject({ kind });
    }
  });

  it('下载：先 stat 拿总大小，Range 透传（end 缺省补到对象末尾）', async () => {
    clientMock.stat.mockResolvedValue({ size: 1000 });
    const stream = Readable.from(['part']);
    clientMock.createReadStream.mockReturnValue(stream);
    const result = await driver.openDownloadStream(makeCtx(), { objectRef: '/tgtc/f', range: { start: 100 } });
    expect(result.size).toBe(1000);
    expect(result.stream).toBe(stream);
    expect(clientMock.createReadStream).toHaveBeenCalledWith('/tgtc/f', { range: { start: 100, end: 999 } });
  });

  it('下载：无 Range 全量取流；stat 404 抛分类错误', async () => {
    clientMock.stat.mockResolvedValue({ size: 42 });
    clientMock.createReadStream.mockReturnValue(Readable.from(['all']));
    const result = await driver.openDownloadStream(makeCtx(), { objectRef: '/f' });
    expect(result.size).toBe(42);
    expect(clientMock.createReadStream).toHaveBeenCalledWith('/f', undefined);

    clientMock.stat.mockRejectedValueOnce(httpError(404));
    await expect(driver.openDownloadStream(makeCtx(), { objectRef: '/gone' })).rejects.toMatchObject({ kind: 'other' });
  });

  it('head：exists=false 短路；存在返回 stat 大小；404 视为不存在', async () => {
    clientMock.exists.mockResolvedValueOnce(false);
    expect(await driver.headObject(makeCtx(), '/f')).toEqual({ exists: false });
    expect(clientMock.stat).not.toHaveBeenCalled();

    clientMock.exists.mockResolvedValueOnce(true);
    clientMock.stat.mockResolvedValueOnce({ size: 7 });
    expect(await driver.headObject(makeCtx(), '/f')).toEqual({ exists: true, size: 7 });

    clientMock.exists.mockRejectedValueOnce(httpError(404));
    expect(await driver.headObject(makeCtx(), '/f')).toEqual({ exists: false });
  });

  it('删除：404 幂等成功；路径规范化补前导斜杠', async () => {
    clientMock.deleteFile.mockResolvedValueOnce(undefined);
    await driver.deleteObject(makeCtx(), 'tgtc/f');
    expect(clientMock.deleteFile).toHaveBeenCalledWith('/tgtc/f');
    clientMock.deleteFile.mockRejectedValueOnce(httpError(404));
    await expect(driver.deleteObject(makeCtx(), '/tgtc/f')).resolves.toBeUndefined();
  });

  it('probe：PROPFIND 根目录成功；404 时创建目录后复测', async () => {
    clientMock.getDirectoryContents.mockResolvedValueOnce([]);
    expect((await driver.probeAccount(makeCtx())).ok).toBe(true);

    clientMock.getDirectoryContents.mockRejectedValueOnce(httpError(404));
    clientMock.createDirectory.mockResolvedValueOnce(undefined);
    expect((await driver.probeAccount(makeCtx())).ok).toBe(true);
    expect(clientMock.createDirectory).toHaveBeenCalledWith('/tgtc/media', { recursive: true });

    clientMock.getDirectoryContents.mockRejectedValueOnce(httpError(401));
    const bad = await driver.probeAccount(makeCtx());
    expect(bad.ok).toBe(false);
    expect(bad.error).toContain('401');
  });

  it('客户端按账号+凭据指纹缓存；createClient 收到正确 URL 与凭据', () => {
    clientMock.getDirectoryContents.mockResolvedValue([]);
    void driver.probeAccount(makeCtx());
    void driver.probeAccount(makeCtx());
    expect(createClient).toHaveBeenCalledTimes(1);
    expect(createClient).toHaveBeenCalledWith(
      'https://dav.example.com/remote.php/dav/files/user',
      { username: 'user', password: 'pass' },
    );
  });

  it('WebDAV 无配额概念：不实现 getQuota', () => {
    expect((driver as { getQuota?: unknown }).getQuota).toBeUndefined();
  });
});