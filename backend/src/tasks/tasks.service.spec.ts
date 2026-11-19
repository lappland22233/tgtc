import { TasksService } from './tasks.service';

const repo = () => ({ delete:jest.fn(),update:jest.fn(),createQueryBuilder:jest.fn() }) as any;
const qb = (affected:number[]) => { const x:any={}; Object.assign(x,{delete:jest.fn(()=>x),from:jest.fn(()=>x),where:jest.fn(()=>x),setParameter:jest.fn(()=>x),execute:jest.fn()}); affected.forEach(v=>x.execute.mockResolvedValueOnce({affected:v})); return x; };

/** 构造 fileRepository 的 queryBuilder 链，用于 recoverStaleProcessingFiles 测试 */
function makeFileRepo(staleIds: string[][], updateAffected: number) {
  let callIndex = 0;
  const selectChain: any = {
    select: jest.fn(() => selectChain),
    where: jest.fn(() => selectChain),
    andWhere: jest.fn(() => selectChain),
    orderBy: jest.fn(() => selectChain),
    limit: jest.fn(() => selectChain),
    getMany: jest.fn(),
  };
  selectChain.getMany
    .mockImplementation(() => Promise.resolve((staleIds.shift() || []).map((id) => ({ id }))));
  const updateChain: any = {
    update: jest.fn(() => updateChain),
    set: jest.fn(() => updateChain),
    where: jest.fn(() => updateChain),
    andWhere: jest.fn(() => updateChain),
    execute: jest.fn(() => Promise.resolve({ affected: updateAffected })),
  };
  return {
    // G3-14 恢复路径：recoverReceiptCommittableFiles 先用 find 查 recoverable 记录，默认无 → 跳过
    find: jest.fn().mockResolvedValue([]),
    createQueryBuilder: jest.fn(() => {
      // 偶数调用（0,2,..）为 select 查询，奇数调用为 update 查询
      return callIndex++ % 2 === 0 ? selectChain : updateChain;
    }),
  };
}

/** 默认 queue 桩：recoverStaleProcessingFiles 内部 recoverReceiptCommittableFiles 不触发入队 */
function makeQueue() {
  return { add: jest.fn() };
}

describe('TasksService', () => {
  const banned=repo(), share=repo(), rate=repo(), audit=repo(), revoked=repo(), files=makeFileRepo([], 0);
  const service=new TasksService(banned,share,rate,audit,revoked,files as any, makeQueue() as any);
  beforeEach(()=>jest.clearAllMocks());

  it('cleans each simple repository and tolerates database failures', async () => {
    const chain:any={}; Object.assign(chain,{delete:jest.fn(()=>chain),from:jest.fn(()=>chain),where:jest.fn(()=>chain),execute:jest.fn().mockResolvedValue({affected:2})}); rate.createQueryBuilder.mockReturnValue(chain);
    share.delete.mockResolvedValue({affected:1}); revoked.delete.mockResolvedValue({affected:1}); banned.update.mockResolvedValue({affected:1});
    await service.cleanupExpiredRateLimits(); await service.cleanupExpiredAccessTokens(); await service.cleanupExpiredRevokedTokens(); await service.cleanupExpiredBans();
    expect(chain.execute).toHaveBeenCalled(); expect(share.delete).toHaveBeenCalled(); expect(revoked.delete).toHaveBeenCalled(); expect(banned.update).toHaveBeenCalled();
    rate.createQueryBuilder.mockImplementation(()=>{throw new Error('db')}); share.delete.mockRejectedValue(new Error('db')); revoked.delete.mockRejectedValue(new Error('db')); banned.update.mockRejectedValue(new Error('db'));
    await expect(service.cleanupExpiredRateLimits()).resolves.toBeUndefined(); await expect(service.cleanupExpiredAccessTokens()).resolves.toBeUndefined();
    await expect(service.cleanupExpiredRevokedTokens()).resolves.toBeUndefined(); await expect(service.cleanupExpiredBans()).resolves.toBeUndefined();
  });

  it('deletes audit logs in bounded batches and handles failures', async () => {
    const chain=qb([1000,2]); audit.createQueryBuilder.mockReturnValue(chain);
    await service.cleanupExpiredAuditLogs(); expect(chain.execute).toHaveBeenCalledTimes(2);
    const failing=qb([]); failing.execute.mockRejectedValue(new Error('db')); audit.createQueryBuilder.mockReturnValue(failing);
    await expect(service.cleanupExpiredAuditLogs()).resolves.toBeUndefined();
  });

  it('recovers stale processing files with a fixed failure reason', async () => {
    const staleRepo = makeFileRepo([['id-1', 'id-2'], []], 2);
    const svc = new TasksService(repo(), repo(), repo(), repo(), repo(), staleRepo as any, makeQueue() as any);
    await svc.recoverStaleProcessingFiles();
    // 只处理 uploadStage 为 pending/uploading 的记录
    const whereCalls = staleRepo.createQueryBuilder.mock.results
      .map((r) => r.value)
      .map((qb) => qb.andWhere);
    const stageWhere = whereCalls
      .flatMap((fn) => fn.mock.calls)
      .find((call) => JSON.stringify(call[1])?.includes('pending'));
    expect(stageWhere).toBeDefined();
    // 固定失败原因不含任何 Telegram 引用
    const setCall = staleRepo.createQueryBuilder.mock.results
      .map((r) => r.value)
      .find((qb) => qb.set)?.set.mock.calls[0]?.[0];
    expect(setCall?.uploadFailureReason).toContain('上传任务超时');
  });

  it('tolerates database failures in stale processing recovery', async () => {
    const failingRepo: any = { find: jest.fn().mockResolvedValue([]), createQueryBuilder: jest.fn(() => { throw new Error('db'); }) };
    const svc = new TasksService(repo(), repo(), repo(), repo(), repo(), failingRepo, makeQueue() as any);
    await expect(svc.recoverStaleProcessingFiles()).resolves.toBeUndefined();
  });

  it('cleans expired bot gdrive files and records purged timestamp', async () => {
    const grantRepo: any = {
      createQueryBuilder: jest.fn(() => ({
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        orderBy: jest.fn().mockReturnThis(),
        offset: jest.fn().mockReturnThis(),
        skip: jest.fn().mockReturnThis(),
        limit: jest.fn().mockReturnThis(),
        getMany: jest.fn().mockResolvedValueOnce([
          {
            id: 'grant-exp-1',
            storageBackend: 'gdrive',
            storageAccountId: 'acc-1',
            storageObjectRef: 'gdrive-file-123',
            storagePurgedAt: null,
          },
        ]).mockResolvedValue([]),
      })),
      save: jest.fn().mockResolvedValue(true),
    };
    const storageRouter: any = {
      deleteRemoteObject: jest.fn().mockResolvedValue(true),
    };
    const svc = new TasksService(repo(), repo(), repo(), repo(), repo(), makeFileRepo([], 0) as any, makeQueue() as any, grantRepo, storageRouter);
    await svc.cleanupExpiredBotRemoteFiles();
    expect(storageRouter.deleteRemoteObject).toHaveBeenCalledWith('gdrive', 'acc-1', 'gdrive-file-123');
    expect(grantRepo.save).toHaveBeenCalledWith(expect.objectContaining({
      id: 'grant-exp-1',
      storagePurgedAt: expect.any(Date),
    }));
  });

  it('cleanupExpiredBotRemoteFiles 在 deleteRemoteObject 返回 false 时不应打上 storagePurgedAt，且重试退避不饥饿后续正常文件', async () => {
    const getMany = jest.fn()
      // 第一次调用：返回失败的记录
      .mockResolvedValueOnce([
        {
          id: 'grant-exp-failed',
          storageBackend: 'gdrive',
          storageAccountId: 'acc-1',
          storageObjectRef: 'gdrive-file-failed',
          storagePurgedAt: null,
        },
      ])
      .mockResolvedValueOnce([])
      // 第二次调用：第一个记录仍返回但已进入冷却退避，后续分页返回健康记录
      .mockResolvedValueOnce([
        {
          id: 'grant-exp-failed',
          storageBackend: 'gdrive',
          storageAccountId: 'acc-1',
          storageObjectRef: 'gdrive-file-failed',
          storagePurgedAt: null,
        },
      ])
      .mockResolvedValueOnce([
        {
          id: 'grant-exp-healthy',
          storageBackend: 'gdrive',
          storageAccountId: 'acc-2',
          storageObjectRef: 'gdrive-file-healthy',
          storagePurgedAt: null,
        },
      ])
      .mockResolvedValue([]);

    const grantRepo: any = {
      createQueryBuilder: jest.fn(() => ({
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        orderBy: jest.fn().mockReturnThis(),
        offset: jest.fn().mockReturnThis(),
        skip: jest.fn().mockReturnThis(),
        limit: jest.fn().mockReturnThis(),
        getMany,
      })),
      save: jest.fn().mockResolvedValue(true),
    };
    const storageRouter: any = {
      deleteRemoteObject: jest.fn((_backend, accId) => Promise.resolve(accId !== 'acc-1')),
    };
    const svc = new TasksService(repo(), repo(), repo(), repo(), repo(), makeFileRepo([], 0) as any, makeQueue() as any, grantRepo, storageRouter);

    // 第 1 轮：失败
    await svc.cleanupExpiredBotRemoteFiles();
    expect(storageRouter.deleteRemoteObject).toHaveBeenCalledWith('gdrive', 'acc-1', 'gdrive-file-failed');
    expect(grantRepo.save).not.toHaveBeenCalled();

    // 第 2 轮：grant-exp-failed 冷却中被跳过，成功处理 grant-exp-healthy
    await svc.cleanupExpiredBotRemoteFiles();
    expect(storageRouter.deleteRemoteObject).toHaveBeenCalledWith('gdrive', 'acc-2', 'gdrive-file-healthy');
    expect(grantRepo.save).toHaveBeenCalledWith(expect.objectContaining({
      id: 'grant-exp-healthy',
      storagePurgedAt: expect.any(Date),
    }));
  });
});
