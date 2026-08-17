import { describe, expect, it } from 'vitest';
import { nextTick, effectScope } from 'vue';
import { useCursorPagination } from './useCursorPagination';

describe('useCursorPagination 目录查询竞态', () => {
  it('reset 后旧目录响应不会污染新查询结果', async () => {
    const scope = effectScope();
    const pagination = scope.run(() => useCursorPagination<string>())!;
    let resolveOld: (result: { data: string[]; nextCursor: string | null; hasMore: boolean }) => void = () => {};

    const oldLoad = pagination.loadMore(
      () => new Promise((resolve) => { resolveOld = resolve; }),
    );
    pagination.reset();
    await pagination.loadMore(async () => ({ data: ['new-folder'], nextCursor: null, hasMore: false }));

    resolveOld({ data: ['stale-folder'], nextCursor: 'stale', hasMore: true });
    await oldLoad;
    await nextTick();

    expect(pagination.data.value).toEqual(['new-folder']);
    expect(pagination.nextCursor.value).toBeNull();
    expect(pagination.hasMore.value).toBe(false);
    scope.stop();
  });

  it('加载期间再次触发查询时，完成当前页后补发最新查询', async () => {
    const pagination = useCursorPagination<string>();
    let resolveFirst: (result: { data: string[]; nextCursor: string | null; hasMore: boolean }) => void = () => {};
    const first = pagination.loadMore(
      () => new Promise((resolve) => { resolveFirst = resolve; }),
    );

    const queued = pagination.loadMore(async (cursor) => ({
      data: [`page-after-${cursor ?? 'root'}`],
      nextCursor: null,
      hasMore: false,
    }));

    resolveFirst({ data: ['first-page'], nextCursor: 'next', hasMore: true });
    await first;
    await queued;
    await Promise.resolve();

    expect(pagination.data.value).toEqual(['first-page', 'page-after-next']);
    expect(pagination.loading.value).toBe(false);
  });
});
