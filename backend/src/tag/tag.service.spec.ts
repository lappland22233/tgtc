import 'reflect-metadata';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { TagService } from './tag.service';
import { Tag } from '../common/entities/tag.entity';

/**
 * B-13：tag 模块此前整体零测试。
 * 覆盖归属校验（IDOR 面）、每用户上限、重名冲突与 TOCTOU、空更新防护、
 * assertOwner 去重，以及删除事务的父行锁顺序。
 */
const userId = '11111111-1111-4111-8111-111111111111';
const otherUserId = '99999999-9999-4999-8999-999999999999';
const tagId = '22222222-2222-4222-8222-222222222222';

function makeTag(overrides: Partial<Tag> = {}): Tag {
  return Object.assign(new Tag(), {
    id: tagId, name: '工作', color: '#0052d9', userId, ...overrides,
  });
}

function makeService(opts: {
  tag?: Tag | null;
  count?: number;
  existing?: Tag | null;
  saveError?: unknown;
  updateError?: unknown;
  ownerCount?: number;
  lockedRows?: Array<{ id: string }>;
} = {}) {
  const qb: any = {
    leftJoin: jest.fn(() => qb),
    select: jest.fn(() => qb),
    addSelect: jest.fn(() => qb),
    where: jest.fn(() => qb),
    andWhere: jest.fn(() => qb),
    groupBy: jest.fn(() => qb),
    orderBy: jest.fn(() => qb),
    getRawMany: jest.fn().mockResolvedValue([]),
    getCount: jest.fn().mockResolvedValue(opts.ownerCount ?? 0),
  };
  const tagRepository = {
    createQueryBuilder: jest.fn(() => qb),
    count: jest.fn().mockResolvedValue(opts.count ?? 0),
    findOne: jest.fn()
      .mockResolvedValueOnce(opts.tag === undefined ? makeTag() : opts.tag)
      .mockResolvedValue(opts.existing ?? null),
    findOneOrFail: jest.fn().mockResolvedValue(makeTag()),
    create: jest.fn((x: any) => makeTag(x)),
    save: jest.fn().mockImplementation(async (t: any) => {
      if (opts.saveError) throw opts.saveError;
      return t;
    }),
    update: jest.fn().mockImplementation(async () => {
      if (opts.updateError) throw opts.updateError;
      return { affected: 1 };
    }),
  };
  const audit = { log: jest.fn() };
  const manager = {
    delete: jest.fn().mockResolvedValue({ affected: 1 }),
    dataSource: { options: { type: 'postgres' } },
    query: jest.fn().mockResolvedValue(opts.lockedRows ?? [{ id: tagId }]),
  };
  const dataSource = {
    transaction: jest.fn(async (cb: any) => cb(manager)),
    options: { type: 'postgres' },
  };
  const service = new TagService(tagRepository as any, audit as any, dataSource as any);
  return { service, tagRepository, audit, manager, qb };
}

describe('TagService 归属与冲突（B-13）', () => {
  it('create 达到每用户上限时拒绝（409）', async () => {
    const { service, tagRepository } = makeService({ count: 200 });
    await expect(service.create(userId, { name: '新标签' } as any))
      .rejects.toBeInstanceOf(ConflictException);
    expect(tagRepository.save).not.toHaveBeenCalled();
  });

  it('create 同名已存在时拒绝（409）', async () => {
    const { service } = makeService({ existing: makeTag() });
    await expect(service.create(userId, { name: '工作' } as any))
      .rejects.toBeInstanceOf(ConflictException);
  });

  it('create 并发撞唯一约束（TOCTOU）转 409，而不是 500', async () => {
    // tag:null 让重名 pre-check 放行，真正走到 save 才撞唯一约束
    const { service, tagRepository } = makeService({
      tag: null,
      saveError: Object.assign(new Error('dup'), { code: '23505' }),
    });
    await expect(service.create(userId, { name: '工作' } as any))
      .rejects.toBeInstanceOf(ConflictException);
    expect(tagRepository.save).toHaveBeenCalled();
  });

  it('create 未传 color 时使用默认色并写审计', async () => {
    const { service, audit } = makeService({ tag: null });
    const created = await service.create(userId, { name: '新标签' } as any);
    expect(created.color).toBe('#0052d9');
    expect(audit.log).toHaveBeenCalledWith(expect.objectContaining({ action: 'tag_create', userId }));
  });

  it('update 传空对象时拒绝（400），不执行更新', async () => {
    const { service, tagRepository } = makeService();
    await expect(service.update(userId, tagId, {} as any))
      .rejects.toBeInstanceOf(BadRequestException);
    expect(tagRepository.update).not.toHaveBeenCalled();
  });

  it('update 标签不存在 → 404', async () => {
    const { service } = makeService({ tag: null });
    await expect(service.update(userId, tagId, { name: 'x' } as any))
      .rejects.toBeInstanceOf(NotFoundException);
  });

  it('update 非属主 → 403（IDOR 负向用例）', async () => {
    const { service, tagRepository } = makeService({ tag: makeTag({ userId: otherUserId }) });
    await expect(service.update(userId, tagId, { name: 'x' } as any))
      .rejects.toBeInstanceOf(ForbiddenException);
    expect(tagRepository.update).not.toHaveBeenCalled();
  });

  it('update 并发重命名撞唯一约束转 409（跨方言，不只认 PG 23505）', async () => {
    const { service } = makeService({
      updateError: Object.assign(new Error('UNIQUE constraint failed: tags.name'), {
        code: 'SQLITE_CONSTRAINT_UNIQUE',
      }),
    });
    await expect(service.update(userId, tagId, { name: '已存在' } as any))
      .rejects.toBeInstanceOf(ConflictException);
  });

  it('delete 非属主 → 403，且不进入删除事务', async () => {
    const { service, manager } = makeService({ tag: makeTag({ userId: otherUserId }) });
    await expect(service.delete(userId, tagId)).rejects.toBeInstanceOf(ForbiddenException);
    expect(manager.delete).not.toHaveBeenCalled();
  });

  it('delete 先锁父行再删除；锁查询为空时抛 404 且不删', async () => {
    const { service, manager } = makeService({ lockedRows: [] });
    await expect(service.delete(userId, tagId)).rejects.toBeInstanceOf(NotFoundException);
    expect(manager.delete).not.toHaveBeenCalled();
  });

  it('delete 正常路径写审计', async () => {
    const { service, audit, manager } = makeService();
    await service.delete(userId, tagId);
    expect(manager.delete).toHaveBeenCalledWith(Tag, tagId);
    expect(audit.log).toHaveBeenCalledWith(expect.objectContaining({ action: 'tag_delete' }));
  });

  it('assertOwner 空数组直接放行，不查库', async () => {
    const { service, tagRepository } = makeService();
    await expect(service.assertOwner(userId, [])).resolves.toBeUndefined();
    expect(tagRepository.createQueryBuilder).not.toHaveBeenCalled();
  });

  it('assertOwner 含重复 id 时按去重后比较，不误判越权', async () => {
    const { service } = makeService({ ownerCount: 1 });
    await expect(service.assertOwner(userId, [tagId, tagId])).resolves.toBeUndefined();
  });

  it('assertOwner 含他人标签时拒绝（403）', async () => {
    const { service } = makeService({ ownerCount: 1 });
    await expect(service.assertOwner(userId, [tagId, 'other-tag'])).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('findAll 只统计未软删文件，fileCount 非法值归零', async () => {
    const { service, qb } = makeService();
    qb.getRawMany.mockResolvedValue([
      { id: tagId, name: '工作', color: '#0052d9', userId, createdAt: new Date(), fileCount: '3' },
      { id: 't2', name: '生活', color: null, userId, createdAt: new Date(), fileCount: null },
    ]);
    const { tags } = await service.findAll(userId);
    expect(tags[0].fileCount).toBe(3);
    expect(tags[1].fileCount).toBe(0);
    // 计数 join 必须带 isDeleted=false，否则回收站文件会把计数撑大
    const joinCalls = qb.leftJoin.mock.calls.map((c: any[]) => c.join(' '));
    expect(joinCalls.some((s: string) => s.includes('isDeleted'))).toBe(true);
  });
});