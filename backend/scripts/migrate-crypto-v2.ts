/**
 * G9-12：一次性迁移脚本——将旧版 AES-256-CBC / 明文格式的加密值迁移至 AES-256-GCM (v2)。
 *
 * 背景：
 * - 历史版本的 crypto.util 使用 AES-256-CBC（无完整性校验，存在 Padding Oracle / 注入风险）
 *   或直接存明文。当前代码已支持 v2 GCM（带 authTag 完整性校验），但存量 DB 中的
 *   SMTP_PASSWORD 等配置值可能仍是旧格式。
 * - 本脚本保守实现"解密旧值 → 用 encryptPassword 重写为 v2"，仅处理被识别为旧格式的值，
 *   v2 值原样跳过，绝不改写已是 v2 的数据。
 *
 * 用法（在 backend 目录，需 .env 提供 DB 连接与 SMTP_ENCRYPTION_KEY/SALT）：
 *   npx ts-node --transpile-only scripts/migrate-crypto-v2.ts [--dry-run]
 *
 * 说明：
 * - 默认直接写库；加 --dry-run 仅打印将迁移的行，不改库。
 * - 迁移前建议备份 system_configs 表。
 * - 运行前提：SMTP_ENCRYPTION_KEY 与 SMTP_ENCRYPTION_SALT 必须与加密这些旧值时一致，
 *   否则解密会失败（脚本会在该行报错并继续/中止，见 RUN_ON_ERROR）。
 * - 风险点：解密失败的行不会被改写（避免破坏数据），需人工核对密钥后处理。
 *
 * 完成本脚本后，所有存量值均为 v2 GCM，CBC/明文分支将不再被命中。
 */
import 'dotenv/config';
import { AppDataSource } from '../src/database/data-source';
import {
  decryptPassword,
  encryptPassword,
  isLegacyEncrypted,
} from '../src/common/utils/crypto.util';

const DRY_RUN = process.argv.includes('--dry-run');
// 遇单行解密失败：true=继续处理其余行（该行保留原值），false=立即中止
const RUN_ON_ERROR = process.argv.includes('--continue-on-error');

async function main(): Promise<void> {
  // 提前校验密钥已配置，避免脚本连上库后才失败
  if (!process.env.SMTP_ENCRYPTION_KEY || !process.env.SMTP_ENCRYPTION_SALT) {
    console.error(
      '[crypto-migrate] 缺少 SMTP_ENCRYPTION_KEY / SMTP_ENCRYPTION_SALT，无法解密/重加密，中止',
    );
    process.exit(1);
  }

  await AppDataSource.initialize();
  const repo = AppDataSource.getRepository('system_configs');
  try {
    const rows: Array<{ key: string; value: string }> = await repo
      .createQueryBuilder('c')
      .select(['c.key', 'c.value'])
      .getRawMany();

    const legacy = rows.filter((r) => isLegacyEncrypted(r.value));
    if (legacy.length === 0) {
      console.log('[crypto-migrate] 未发现旧格式（CBC/明文）值，无需迁移。');
      return;
    }

    console.log(
      `[crypto-migrate] 发现 ${legacy.length} 个旧格式值（${DRY_RUN ? 'DRY-RUN，不写库' : '将写库'}）：`,
    );
    legacy.forEach((r) => console.log(`  - ${r.key}`));

    if (DRY_RUN) return;

    let migrated = 0;
    let failed = 0;
    for (const row of legacy) {
      try {
        const plain = decryptPassword(row.value);
        const v2 = encryptPassword(plain);
        await repo
          .createQueryBuilder()
          .update('system_configs')
          .set({ value: v2, updatedAt: new Date() })
          .where('"key" = :key', { key: row.key })
          .execute();
        console.log(`  ✓ ${row.key} 已迁移至 v2`);
        migrated += 1;
      } catch (error) {
        failed += 1;
        const msg = error instanceof Error ? error.message : String(error);
        console.error(`  ✗ ${row.key} 迁移失败（已保留原值）：${msg}`);
        if (!RUN_ON_ERROR) {
          console.error('[crypto-migrate] 因解密失败中止（可用 --continue-on-error 跳过失败行）');
          break;
        }
      }
    }
    console.log(
      `[crypto-migrate] 完成：迁移 ${migrated}，失败 ${failed}。` +
        (failed > 0
          ? ' 失败行请核对 SMTP_ENCRYPTION_KEY/SALT 后重跑。'
          : ' 存量加密值现均为 v2 GCM。'),
    );
  } finally {
    await AppDataSource.destroy();
  }
}

main().catch((err) => {
  console.error('[crypto-migrate] 脚本异常：', err);
  process.exit(1);
});
