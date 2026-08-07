import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * 回填存量账号的邮箱验证状态（emailVerified → true）。
 *
 * 背景：历史上 EMAIL_VERIFICATION_ENABLED 默认关闭，存量账号注册时从未被要求
 * 邮箱验证，但 users.emailVerified 字段默认值为 false。管理员后续开启邮箱
 * 验证后，登录拦截（auth.service.login）与 JWT 校验（jwt.strategy）会对
 * emailVerified=false 的存量账号一律拒绝，导致存量账号无法登录。
 *
 * 这些账号在注册时从未被要求验证，语义上应视为已验证。本迁移一次性将所有
 * 存量用户的 emailVerified 置为 true。回填后，登录拦截仅对"开启开关之后
 * 新注册且从未验证"的账号生效，精确满足业务预期。
 *
 * 幂等性：UPDATE 使用 WHERE 条件只作用于 false 行，重复执行不产生副作用；
 * 且迁移本身由 TypeORM 迁移记录表保证只执行一次。
 */
export class BackfillEmailVerified1791100000000 implements MigrationInterface {
  name = 'BackfillEmailVerified1791100000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // WHERE 条件保证幂等：仅更新仍为 false 的行，重复执行无影响。
    await queryRunner.query(
      `UPDATE "users" SET "emailVerified" = true WHERE "emailVerified" = false`,
    );
  }

  public async down(): Promise<void> {
    // 数据回填不可精确撤销（无法区分回填行与用户后续真实验证的行），
    // 且回滚为 false 会重新引入"存量账号无法登录"的问题，故 down 为空操作。
  }
}
