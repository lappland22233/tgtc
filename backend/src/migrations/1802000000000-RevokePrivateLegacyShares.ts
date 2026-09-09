import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * v1.2.6 安全回填：撤销「文件已转私有但 legacy 公开直链仍存活」的分享。
 *
 * 背景：FileService.updateAccessType 的历史缺陷（share_links.token varchar 与
 * targetId uuid 跨类型比较导致撤销失败）使部分已转私有的文件仍保留
 * token = fileId 的 legacy 公开直链，可被已知文件 ID 的攻击者继续访问。
 *
 * 幂等：重复执行不会产生额外变更（isDeleted 已为 true 的行不再匹配）。
 * 仅记录于迁移本身，不打印任何 token 明文。
 */
export class RevokePrivateLegacyShares1802000000000 implements MigrationInterface {
  name = 'RevokePrivateLegacyShares1802000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    const result = await queryRunner.query(`
      UPDATE "share_links"
      SET "isDeleted" = true, "updatedAt" = NOW()
      WHERE "isDeleted" = false
        AND "targetType" = 'file'
        AND "token" = "targetId"::text
        AND EXISTS (
          SELECT 1 FROM "files" f
          WHERE f."id" = "share_links"."targetId"
            AND f."accessType" = 'private'
        )
    `);
    const revoked = Array.isArray(result) ? result.length : (result?.affected ?? 0);
    // 仅输出数量，不输出任何 token / fileId 明文
    // eslint-disable-next-line no-console
    console.log(`[RevokePrivateLegacyShares] revoked legacy public links: ${revoked}`);
  }

  public async down(): Promise<void> {
    // 安全状态收紧，不可逆：撤销的 legacy 直链不恢复。
  }
}
