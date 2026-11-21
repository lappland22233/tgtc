import { BadRequestException, Injectable, OnModuleDestroy } from '@nestjs/common';
import { createHash, randomBytes } from 'crypto';
import { DataSource, EntityManager, In, IsNull, LessThanOrEqual, MoreThan, Not } from 'typeorm';
import { GDriveOAuthFlow } from '../common/entities/gdrive-oauth-flow.entity';
import { GDriveBackendConfig, StorageBackend } from '../common/entities/storage-backend.entity';
import { isSqliteBusy } from '../database/database-types';
import { setTimeout as delay } from 'node:timers/promises';
import { SystemConfig } from '../common/entities/system-config.entity';

export const GDRIVE_OAUTH_CLIENT_ID_KEY = 'GDRIVE_OAUTH_CLIENT_ID';
export const GDRIVE_OAUTH_CLIENT_SECRET_KEY = 'GDRIVE_OAUTH_CLIENT_SECRET';
export const GDRIVE_OAUTH_REDIRECT_URI_KEY = 'GDRIVE_OAUTH_REDIRECT_URI';
const settingsKeys = [GDRIVE_OAUTH_CLIENT_ID_KEY, GDRIVE_OAUTH_CLIENT_SECRET_KEY, GDRIVE_OAUTH_REDIRECT_URI_KEY];

function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

@Injectable()
export class GDriveOAuthStore implements OnModuleDestroy {
  // TypeORM's SQLite query runners share one connection. A second connection keeps
  // consumption and account/config writes outside unrelated application transactions.
  private sqliteConnection?: Promise<DataSource>;
  private sqliteWriter = Promise.resolve();

  constructor(private readonly db: DataSource) {}

  settings() {
    return this.withConnection(db => this.readSettings(db.manager));
  }

  private async readSettings(manager: EntityManager) {
    const rows = await manager.findBy(SystemConfig, { key: In(settingsKeys) });
    const entries = new Map(rows.map(row => [row.key, row.value]));
    const clientId = entries.get(GDRIVE_OAUTH_CLIENT_ID_KEY)?.trim() || '';
    const secretCipher = entries.get(GDRIVE_OAUTH_CLIENT_SECRET_KEY)?.trim() || '';
    const redirectUri = entries.get(GDRIVE_OAUTH_REDIRECT_URI_KEY)?.trim() || null;
    return { clientId, secretCipher, redirectUri, revision: digest(JSON.stringify([clientId, secretCipher])) };
  }

  async writeSettings(clientId: string, newCipher?: string, redirectUri?: string): Promise<void> {
    await this.locked(async manager => {
      const previous = await this.readSettings(manager);
      if (!clientId || previous.clientId !== clientId) {
        const dependents = await manager.countBy(StorageBackend, {
          type: 'gdrive', status: Not('revoked'), credentialCiphertext: Not(IsNull()),
        });
        if (dependents) throw new BadRequestException('请先撤销依赖当前 OAuth Client 的 Google Drive 存储账号');
      }
      if (clientId && previous.clientId !== clientId && !newCipher) {
        throw new BadRequestException('首次配置或更换 OAuth Client 必须提供 client_secret');
      }
      const cipher = clientId ? newCipher || previous.secretCipher : '';
      if (clientId && !cipher) throw new BadRequestException('必须提供 client_secret');
      const values = [clientId, cipher, redirectUri ?? previous.redirectUri ?? ''];
      await manager.upsert(SystemConfig, settingsKeys.map((key, i) => ({ key, value: values[i] })), ['key']);
    });
  }

  async saveAccount(row: StorageBackend, expectedRevision: string, authorizedEmail?: string): Promise<StorageBackend> {
    return this.locked(async manager => {
      const current = await this.readSettings(manager);
      if (!current.clientId || !current.secretCipher || current.revision !== expectedRevision) {
        throw new BadRequestException('Google OAuth 客户端配置已变更，请重新发起授权');
      }
      if (!row.id) return manager.save(StorageBackend, row);
      const existing = await manager.findOneByOrFail(StorageBackend, { id: row.id, type: 'gdrive' });
      const priorEmail = (existing.config as GDriveBackendConfig | null)?.email?.trim().toLowerCase();
      if (priorEmail && authorizedEmail?.trim().toLowerCase() !== priorEmail) {
        throw new BadRequestException('授权邮箱与当前账号不一致，请使用原 Google 账号重新授权');
      }
      if (authorizedEmail) existing.config = { ...existing.config, email: authorizedEmail };
      existing.credentialCiphertext = row.credentialCiphertext;
      existing.credentialVersion = row.credentialVersion;
      if (existing.status === 'revoked') existing.enabled = true;
      existing.status = existing.enabled ? 'active' : 'disabled';
      existing.lastFailureCode = null;
      existing.lastFailureSummary = null;
      existing.updatedBy = row.updatedBy;
      return manager.save(StorageBackend, existing);
    });
  }

  async issue(binding: string): Promise<string> {
    const now = Math.floor(Date.now() / 1000);
    const state = randomBytes(32).toString('base64url');
    return this.withConnection(async db => {
      const repo = db.getRepository(GDriveOAuthFlow);
      await repo.delete({ expiresAt: LessThanOrEqual(now) });
      await repo.insert({ stateHash: digest(state), bindingHash: digest(binding), expiresAt: now + 900 });
      return state;
    });
  }

  async consume(state: string, binding: string): Promise<void> {
    const result = await this.withConnection(db => db.getRepository(GDriveOAuthFlow).delete({
      stateHash: digest(state), bindingHash: digest(binding), expiresAt: MoreThan(Math.floor(Date.now() / 1000)),
    }));
    if (result.affected !== 1) throw new BadRequestException('授权状态无效、已使用或已过期，请重新发起授权');
  }

  private locked<T>(action: (manager: EntityManager) => Promise<T>): Promise<T> {
    return this.withConnection(db => db.transaction(async manager => {
      if (db.options.type === 'better-sqlite3') {
        await manager.query('UPDATE system_configs SET value = value WHERE key = ?', [GDRIVE_OAUTH_CLIENT_ID_KEY]);
      } else {
        await manager.query('SELECT pg_advisory_xact_lock(hashtext($1))', ['tgtc:gdrive-oauth-config']);
      }
      return action(manager);
    }));
  }

  async onModuleDestroy(): Promise<void> {
    await this.sqliteWriter;
    if (this.sqliteConnection) await (await this.sqliteConnection).destroy();
  }

  private withConnection<T>(action: (db: DataSource) => Promise<T>): Promise<T> {
    const options = this.db.options;
    if (options.type !== 'better-sqlite3') return action(this.db);
    const run = async () => {
      if (options.database === ':memory:') return action(this.db);
      this.sqliteConnection ??= new DataSource({
        ...options, timeout: 0, entities: [SystemConfig, StorageBackend, GDriveOAuthFlow],
        synchronize: false, migrationsRun: false, dropSchema: false,
      }).initialize().catch(error => {
        this.sqliteConnection = undefined;
        throw error;
      });
      const connection = await this.sqliteConnection;
      const deadline = Date.now() + (options.timeout ?? 5000);
      // A synchronous SQLite busy handler would prevent the primary connection
      // from committing on this event loop. Retry whole rolled-back transactions.
      for (;;) {
        try {
          return await action(connection);
        } catch (error) {
          const remaining = deadline - Date.now();
          if (!isSqliteBusy(error) || remaining <= 0) throw error;
          await delay(Math.min(25, remaining));
        }
      }
    };
    const writing = this.sqliteWriter.then(run);
    this.sqliteWriter = writing.then(() => {}, () => {});
    return writing;
  }
}
