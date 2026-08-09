import { TasksService } from './tasks.service';

const repo = () => ({ delete:jest.fn(),update:jest.fn(),createQueryBuilder:jest.fn() }) as any;
const qb = (affected:number[]) => { const x:any={}; Object.assign(x,{delete:jest.fn(()=>x),from:jest.fn(()=>x),where:jest.fn(()=>x),setParameter:jest.fn(()=>x),execute:jest.fn()}); affected.forEach(v=>x.execute.mockResolvedValueOnce({affected:v})); return x; };

describe('TasksService', () => {
  const banned=repo(), share=repo(), rate=repo(), audit=repo(), revoked=repo();
  const service=new TasksService(banned,share,rate,audit,revoked);
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
});
