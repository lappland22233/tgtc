import { GDriveCacheRetryService } from './gdrive-cache-retry.service';

function setup(overrides: {
  storageMode?: 'telegram' | 'gdrive';
  cacheMode?: boolean;
  files?: string[];
  fileBacklog?: number;
  grantBacklog?: number;
} = {}) {
  const botConfig = {
    getConfig: jest.fn(async () => ({ storageMode: overrides.storageMode ?? 'telegram' })),
  };
  const dispatch = { retryDueGDriveCacheMirrors: jest.fn(async () => undefined) };
  const fileService = {
    findDueGDriveCacheMirrorIds: jest.fn(async () => overrides.files ?? ['f1']),
    mirrorGDriveCache: jest.fn(async () => undefined),
    countDueGDriveCacheMirrors: jest.fn(async () => overrides.fileBacklog ?? 0),
  };
  const grantService = { countDueGDriveCacheMirrors: jest.fn(async () => overrides.grantBacklog ?? 0) };
  const storageRouter = { isGDriveCacheModeEnabled: jest.fn(async () => overrides.cacheMode ?? true) };
  const release = jest.fn();
  const downloadResources = { acquireUpstreamSlot: jest.fn(async () => ({ release })) };
  const alertEngine = { createAlerts: jest.fn(async () => undefined) };
  const service = new GDriveCacheRetryService(
    botConfig as never,
    dispatch as never,
    fileService as never,
    grantService as never,
    storageRouter as never,
    downloadResources as never,
    alertEngine as never,
  );
  return { service, dispatch, fileService, grantService, storageRouter, downloadResources, alertEngine, release };
}

describe('GDriveCacheRetryService', () => {
  it('非 Telegram 存储模式时整轮跳过', async () => {
    const ctx = setup({ storageMode: 'gdrive' });
    await ctx.service.run();
    expect(ctx.fileService.findDueGDriveCacheMirrorIds).not.toHaveBeenCalled();
    expect(ctx.dispatch.retryDueGDriveCacheMirrors).not.toHaveBeenCalled();
  });

  it('Google 缓存模式关闭时整轮跳过', async () => {
    const ctx = setup({ cacheMode: false });
    await ctx.service.run();
    expect(ctx.fileService.findDueGDriveCacheMirrorIds).not.toHaveBeenCalled();
    expect(ctx.dispatch.retryDueGDriveCacheMirrors).not.toHaveBeenCalled();
  });

  it('开启时重试网页文件与 Bot 直链，并释放上行租约', async () => {
    const ctx = setup({ files: ['f1', 'f2'] });
    await ctx.service.run();

    expect(ctx.fileService.mirrorGDriveCache).toHaveBeenNthCalledWith(1, 'f1');
    expect(ctx.fileService.mirrorGDriveCache).toHaveBeenNthCalledWith(2, 'f2');
    expect(ctx.downloadResources.acquireUpstreamSlot).toHaveBeenCalledTimes(2);
    expect(ctx.release).toHaveBeenCalledTimes(2);
    expect(ctx.dispatch.retryDueGDriveCacheMirrors).toHaveBeenCalledWith(5);
  });

  it('积压超过阈值时创建 Google 双写积压告警', async () => {
    const ctx = setup({ fileBacklog: 3, grantBacklog: 3 });
    await ctx.service.run();
    expect(ctx.alertEngine.createAlerts).toHaveBeenCalledWith([
      expect.objectContaining({ ruleId: 'GDRIVE_CACHE_BACKLOG', level: 'warning' }),
    ]);
  });

  it('积压未超过阈值时不告警', async () => {
    const ctx = setup({ fileBacklog: 2, grantBacklog: 3 });
    await ctx.service.run();
    expect(ctx.alertEngine.createAlerts).not.toHaveBeenCalled();
  });
});
