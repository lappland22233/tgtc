import { NotFoundException } from '@nestjs/common';
import { AlertService } from './alert.service';
import { AlertLevel } from '../common/entities/alert.entity';

describe('AlertService',()=>{
 const repo:any={findAndCount:jest.fn(),find:jest.fn(),update:jest.fn(),manager:{query:jest.fn()}}; const s=new AlertService(repo);
 beforeEach(()=>jest.clearAllMocks());
 it('clamps pagination and builds acknowledged filters',async()=>{repo.findAndCount.mockResolvedValue([[],0]); await s.getAlerts({page:-1,limit:500,level:AlertLevel.CRITICAL,acknowledged:true}); expect(repo.findAndCount).toHaveBeenCalledWith(expect.objectContaining({skip:0,take:100,where:expect.objectContaining({level:AlertLevel.CRITICAL})})); await s.getAlerts({acknowledged:false}); expect(repo.findAndCount).toHaveBeenCalledTimes(2)});
 it('lists unacknowledged alerts',async()=>{repo.find.mockResolvedValue(['a']); await expect(s.getUnacknowledged()).resolves.toEqual(['a']);});
 it('acknowledges existing alert and rejects missing alert',async()=>{repo.update.mockResolvedValueOnce({affected:1}).mockResolvedValueOnce({affected:0}); await expect(s.acknowledge('a','u')).resolves.toBeUndefined(); await expect(s.acknowledge('x','u')).rejects.toBeInstanceOf(NotFoundException)});
 it('acknowledges all in batches and ignores invalid result shape',async()=>{repo.manager.query.mockResolvedValueOnce(Array(1000).fill({})).mockResolvedValueOnce([{}]); await expect(s.acknowledgeAll('u')).resolves.toBe(1001); repo.manager.query.mockResolvedValue({}); await expect(s.acknowledgeAll('u')).resolves.toBe(0)});
 it('returns rule metadata',()=>expect(s.getRules().length).toBeGreaterThan(0));
});
