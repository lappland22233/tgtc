import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * 修复 api_keys.id 缺失的默认值（PostgreSQL）。
 *
 * 上游 4e0da52 的 CreateApiKeys 建表时将 "id" 声明为 uuid NOT NULL
 * 但遗漏了 DEFAULT 表达式；@PrimaryGeneratedColumn('uuid') 在 PG 下
 * 依赖数据库端默认值生成主键，导致 INSERT 省略 id 时违反非空约束。
 *
 * - 仅补充列默认值元数据（ALTER COLUMN ... SET DEFAULT），不重建表、
 *   不回填或改写已有 id，瞬时持有表锁但无数据扫描；
 * - gen_random_uuid() 为 PG13+ 内置，与 1797000000000 迁移保持一致；
 * - 存量库与本迁移、空库走完整迁移链（CreateApiKeys 建表 + 本迁移）
 *   两种路径均收敛到相同结构，因此历史迁移保持原样不再改动。
 */
export class FixApiKeysIdDefault1801000000001 implements MigrationInterface {
  name = 'FixApiKeysIdDefault1801000000001';

  public async up(queryRunner: QueryRunner): Promise<void> {
    if (queryRunner.connection.options.type !== 'postgres') return;
    await queryRunner.query(
      `ALTER TABLE "api_keys" ALTER COLUMN "id" SET DEFAULT gen_random_uuid()`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    if (queryRunner.connection.options.type !== 'postgres') return;
    await queryRunner.query(`ALTER TABLE "api_keys" ALTER COLUMN "id" DROP DEFAULT`);
  }
}
