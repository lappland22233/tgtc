import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * `share_preview_sessions` 增加 `hitCount`（PostgreSQL）。
 *
 * 退款与幂等 follower 的竞态：leader 扣次后会话已提交，同 visitorHash 的并发请求命中
 * idempotent 免扣并成功取流；leader 取流失败触发退款会抹掉 follower 已消费的额度。
 * hitCount 记录会话被幂等命中的次数，退款只在 0 命中时执行。
 */
export class AddSharePreviewSessionHitCount1805000000000 implements MigrationInterface {
  name = 'AddSharePreviewSessionHitCount1805000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    if (queryRunner.dataSource.options.type !== 'postgres') return;

    await queryRunner.query(
      'ALTER TABLE "share_preview_sessions" ADD COLUMN IF NOT EXISTS "hitCount" integer NOT NULL DEFAULT 0',
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    if (queryRunner.dataSource.options.type !== 'postgres') return;

    await queryRunner.query('ALTER TABLE "share_preview_sessions" DROP COLUMN IF EXISTS "hitCount"');
  }
}