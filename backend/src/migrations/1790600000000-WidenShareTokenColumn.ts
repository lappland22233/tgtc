import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * 加宽 share_links.token 列：varchar(32) → varchar(64)。
 *
 * 背景：Phase 2 的 CreateShareLinksTable 迁移把 token 设为 varchar(32)，
 * 但数据迁移和懒创建路径会把文件 UUID（36 字符）作为 token 插入，
 * 导致已跑过旧迁移的生产库在插入时报 "value too long for type character varying(32)"。
 *
 * 此迁移对已跑过 CreateShareLinksTable 的库执行 ALTER COLUMN，
 * 对新库（已用 varchar(64) 建表）是幂等的（IF EXISTS + 类型已匹配时 ALTER 无副作用）。
 */
export class WidenShareTokenColumn1790600000000 implements MigrationInterface {
  name = 'WidenShareTokenColumn1790600000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // 检查列是否存在（share_links 表可能尚未创建——新库走 CreateShareLinksTable 已用 varchar(64)）
    const cols = await queryRunner.query(`
      SELECT column_name FROM information_schema.columns
      WHERE table_name = 'share_links' AND column_name = 'token'
    `);
    if (cols.length === 0) return; // 表不存在，跳过

    // 加宽列类型（PostgreSQL ALTER COLUMN TYPE 是幂等的，varchar(64) → varchar(64) 无副作用）
    await queryRunner.query(`
      ALTER TABLE "share_links"
      ALTER COLUMN "token" TYPE varchar(64)
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // 回滚：缩回 varchar(32)——注意：如果已有 36 字符的 token 会失败
    // 这是预期行为：回滚前应确保没有长 token 存在
    const cols = await queryRunner.query(`
      SELECT column_name FROM information_schema.columns
      WHERE table_name = 'share_links' AND column_name = 'token'
    `);
    if (cols.length === 0) return;

    await queryRunner.query(`
      ALTER TABLE "share_links"
      ALTER COLUMN "token" TYPE varchar(32)
    `);
  }
}
