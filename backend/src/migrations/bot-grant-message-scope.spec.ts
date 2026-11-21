import { DataSource } from 'typeorm';
import { SqliteScopeBotGrantMessage1804400000000 } from './1804400000000-SqliteScopeBotGrantMessage';

it('保留旧授权，并允许不同接收 Bot 各自签发相同消息号', async () => {
  const db = await new DataSource({ type: 'sqlite', database: ':memory:' }).initialize();
  const runner = db.createQueryRunner();
  const migration = new SqliteScopeBotGrantMessage1804400000000();
  try {
    await runner.query('CREATE TABLE telegram_bot_file_grants (id TEXT PRIMARY KEY, telegramUserId TEXT, chatId TEXT, messageId TEXT)');
    await runner.query('CREATE UNIQUE INDEX uq_tg_bot_grants_message ON telegram_bot_file_grants (telegramUserId, chatId, messageId)');
    await runner.query("INSERT INTO telegram_bot_file_grants VALUES ('old', 'user', 'chat', '42')");
    await migration.up(runner);
    await migration.up(runner); // A fresh baseline may already have current entity columns and indices.
    const insert = (id: string, receiver: string | null) => runner.query(
      'INSERT INTO telegram_bot_file_grants VALUES (?, ?, ?, ?, ?)', [id, 'user', 'chat', '42', receiver],
    );
    await insert('first', 'bot-1');
    await insert('second', 'bot-2');
    await expect(insert('repeat', 'bot-2')).rejects.toThrow(/unique/i);
    await expect(insert('legacy-repeat', null)).rejects.toThrow(/unique/i);
    await expect(migration.down(runner)).rejects.toThrow(/unique/i);
    expect(await runner.query('SELECT COUNT(*) AS rows FROM telegram_bot_file_grants')).toEqual([{ rows: 3 }]);
    await runner.query('DELETE FROM telegram_bot_file_grants WHERE receiverBotId IS NOT NULL');
    await migration.down(runner);
    expect(await runner.query('SELECT id FROM telegram_bot_file_grants')).toEqual([{ id: 'old' }]);
  } finally {
    await runner.release();
    await db.destroy();
  }
});
