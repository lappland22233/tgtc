import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * G2-10：文件名搜索 trigram 索引。
 *
 * 背景：
 * - `file.service.ts` 的文件名搜索使用 `LOWER(file.originalName) LIKE '%keyword%'`
 *   的中间通配符模糊匹配。普通 B-tree 索引对前导通配符的 LIKE 无法生效，
 *   每次搜索都会对 files 表做全表扫描（双全表扫描：列表查询 + count 查询）。
 * - 本迁移启用 `pg_trgm` 扩展并创建基于 `LOWER(originalName)` 的 GIN 索引，
 *   使 `ILIKE`/`LIKE '%kw%'` 类查询可走 trigram 索引，显著降低大表下搜索延迟。
 *
 * 风险点：
 * - `CREATE EXTENSION IF NOT EXISTS pg_trgm` 需要数据库超级用户或具备
 *   `CREATE` 权限；大多数托管 PG 允许，若权限不足迁移会失败，需人工建扩展。
 * - GIN trigram 索引对写放大有一定开销（每次 INSERT/UPDATE originalName 需更新索引），
 *   对以读为主的网盘场景收益远大于代价。
 * - 服务层查询不变（仍为 LOWER(...) LIKE），本迁移仅补索引，不改变语义。
 */
export class AddFileNameTrigramIndex1798100000000 implements MigrationInterface {
  name = 'AddFileNameTrigramIndex1798100000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // 1. 启用 pg_trgm 扩展（幂等）
    await queryRunner.query(`CREATE EXTENSION IF NOT EXISTS pg_trgm`);

    // 2. 为文件名小写形式建 GIN trigram 索引（幂等）
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "idx_files_original_name_trgm"
       ON "files" USING gin (LOWER("originalName") gin_trgm_ops)`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // 向下迁移：删除索引。不删除 pg_trgm 扩展（可能被其他索引/查询使用，
    // 且删除扩展为破坏性操作，保留）。
    await queryRunner.query(`DROP INDEX IF EXISTS "idx_files_original_name_trgm"`);
  }
}
