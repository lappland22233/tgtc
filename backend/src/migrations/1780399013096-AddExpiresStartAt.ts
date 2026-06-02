import { MigrationInterface, QueryRunner } from "typeorm";

export class AddExpiresStartAt1780399013096 implements MigrationInterface {
    name = 'AddExpiresStartAt1780399013096'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "files" ADD COLUMN "expiresStartAt" timestamp`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "files" DROP COLUMN "expiresStartAt"`);
    }
}
