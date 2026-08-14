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
    createQueryBuilder: jest.fn(() => {
      // 偶数调用（0,2,..）为 select 查询，奇数调用为 update 查询
      return callIndex++ % 2 === 0 ? selectChain : updateChain;
    }),
  };
}

describe('TasksService', () => {
  const banned=repo(), share=repo(), rate=repo(), audit=repo(), revoked=repo(), files=makeFileRepo([], 0);
  const service=new TasksService(banned,share,rate,audit,revoked,files as any);
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
    const svc = new TasksService(repo(), repo(), repo(), repo(), repo(), staleRepo as any);
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
    const failingRepo: any = { createQueryBuilder: jest.fn(() => { throw new Error('db'); }) };
    const svc = new TasksService(repo(), repo(), repo(), repo(), repo(), failingRepo);
    await expect(svc.recoverStaleProcessingFiles()).resolves.toBeUndefined();
  });
});
