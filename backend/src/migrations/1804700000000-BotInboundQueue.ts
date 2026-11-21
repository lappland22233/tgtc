import { MigrationInterface, QueryRunner } from 'typeorm';
import { createBotInboundQueue } from './bot-inbound-queue-schema';

export class BotInboundQueue1804700000000 implements MigrationInterface {
  async up(runner: QueryRunner): Promise<void> {
    if (runner.dataSource.options.type !== 'postgres') return;
    await createBotInboundQueue(runner, false);
    await runner.query('ALTER TABLE "telegram_bot_file_grants" ALTER COLUMN "revokedBy" TYPE varchar(64)');
  }

  async down(): Promise<void> {
    // Existing tasks, bans and recorded administrator IDs must survive a rollback and replay.
  }
}
