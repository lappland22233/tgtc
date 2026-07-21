import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * 核心基础设施修复合集：
 * 1. users 表新增 deletedAt 列，支持用户软删除。
 *    背景：files.uploaderId → users.id 外键无 ON DELETE 策略，硬删除有文件的用户恒失败（500）。
 *    采用软删除（保留用户行）后外键始终满足，是最安全的方案，无需改动既有外键约束。
 * 2. tags 表新增 userId 单列索引。
 *    背景：findAll 按 userId 过滤，缺少单列索引时顺序扫描。
 */
export class CoreInfraFixes1790700300000 implements MigrationInterface {
  name = 'CoreInfraFixes1790700300000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // 1. 用户软删除支持（与实体 @DeleteDateColumn 对应，列名 deletedAt）
    await queryRunner.query(`
      ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "deletedAt" TIMESTAMP NULL
    `);

    // 2. tags.userId 单列索引（CONCURRENTLY 不能在事务内执行，此处使用普通建索引；
    //    tags 表数据量小，短暂持锁可接受）
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_tags_userId" ON "tags" ("userId")
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "idx_tags_userId"`);
    await queryRunner.query(`ALTER TABLE "users" DROP COLUMN IF EXISTS "deletedAt"`);
  }
}
