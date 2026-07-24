import { MigrationInterface, QueryRunner, TableColumn } from 'typeorm';

export class AddTelegramMessageId1790700400000 implements MigrationInterface {
  name = 'AddTelegramMessageId1790700400000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.addColumn(
      'files',
      new TableColumn({
        name: 'telegramMessageId',
        type: 'bigint',
        isNullable: true,
      }),
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.dropColumn('files', 'telegramMessageId');
  }
}
