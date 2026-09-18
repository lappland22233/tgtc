import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * access_logs 传输结果字段（PostgreSQL）。
 *
 * 用于把「下载请求数 / 分段数 / 完整完成数 / 中断数」拆开：历史实现只在开始输出前
 * 记一次访问，客户端中断与上游失败都被统计成成功下载，多段 Range 还会被重复计数，
 * 导致「生产 0 次 206」这类问题无法从数据侧证实或证伪。
 *
 * 全部可空：只对下载类请求写入，其他请求保持 NULL，避免污染既有报表口径。
 */
export class AddAccessLogTransferFields1802600000000 implements MigrationInterface {
  name = 'AddAccessLogTransferFields1802600000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "access_logs" ADD COLUMN IF NOT EXISTS "transferCompleted" boolean`,
    );
    await queryRunner.query(
      `ALTER TABLE "access_logs" ADD COLUMN IF NOT EXISTS "transferAborted" boolean`,
    );
    await queryRunner.query(`ALTER TABLE "access_logs" ADD COLUMN IF NOT EXISTS "ranged" boolean`);
    await queryRunner.query(
      `ALTER TABLE "access_logs" ADD COLUMN IF NOT EXISTS "terminationReason" character varying(24)`,
    );
    await queryRunner.query(
      `ALTER TABLE "access_logs" ADD COLUMN IF NOT EXISTS "responseBodyBytes" bigint`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "access_logs" DROP COLUMN IF EXISTS "responseBodyBytes"`);
    await queryRunner.query(`ALTER TABLE "access_logs" DROP COLUMN IF EXISTS "terminationReason"`);
    await queryRunner.query(`ALTER TABLE "access_logs" DROP COLUMN IF EXISTS "ranged"`);
    await queryRunner.query(`ALTER TABLE "access_logs" DROP COLUMN IF EXISTS "transferAborted"`);
    await queryRunner.query(`ALTER TABLE "access_logs" DROP COLUMN IF EXISTS "transferCompleted"`);
  }
}
