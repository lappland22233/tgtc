import { MigrationInterface, QueryRunner } from "typeorm";

export class AddPasswordUpdatedAt1783445000000 implements MigrationInterface {
    name = 'AddPasswordUpdatedAt1783445000000'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "passwordUpdatedAt" TIMESTAMP WITH TIME ZONE`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "users" DROP COLUMN IF EXISTS "passwordUpdatedAt"`);
    }
}
