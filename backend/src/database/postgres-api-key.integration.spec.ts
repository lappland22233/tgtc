import { createHash, randomUUID } from 'crypto';
import { DataSource } from 'typeorm';
import { createDatabaseOptions } from './database.config';
import { User } from '../common/entities/user.entity';
import { ApiKey } from '../common/entities/api-key.entity';
import { ApiKeyService } from '../api-key/api-key.service';

/**
 * PostgreSQL 真库回归：api_keys.id 默认值修复（FixApiKeysIdDefault1801000000001）。
 *
 * 背景：上游 4e0da52 的 CreateApiKeys 建表遗漏 id DEFAULT，PG 下
 * @PrimaryGeneratedColumn('uuid') 依赖数据库端默认值，INSERT 省略 id
 * 直接触发非空约束（生产 23502）。服务单测的 mock save 自动补 id，
 * 完全掩盖该缺陷，因此必须用真实 PG + 正式迁移链验证插入路径。
 *
 * 运行方式：需要真实 PostgreSQL（CI 由 quality-gates.yml 的 PG16 服务提供）。
 * - CI / 本地启用：`npm run test:integration:pg`（注入 PG_API_KEY_IT=1）；
 * - 未注入开关时跳过（本地无 PG 环境的常规单测场景）；
 *   CI 步骤显式设置开关并断言测试套件被执行，不允许静默跳过。
 * - 全程使用按次创建的隔离数据库，结束即销毁，绝不触碰目标业务库。
 */

const FIX_MIGRATION_NAME = 'FixApiKeysIdDefault1801000000001';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const PG_ENABLED = process.env.PG_API_KEY_IT === '1';
const describePg = PG_ENABLED ? describe : describe.skip;

/** 管理连接：连接目标库（非隔离库），仅用于创建/销毁按次隔离的测试数据库 */
const admin = new DataSource({
  type: 'postgres',
  host: process.env.DB_HOST || '127.0.0.1',
  port: Number(process.env.DB_PORT || 5432),
  username: process.env.DB_USERNAME || 'postgres',
  password: process.env.DB_PASSWORD || 'postgres',
  database: process.env.DB_DATABASE || 'file_distribution_ci',
});

const ISOLATED_DB = `tgtc_pgkeyit_${process.pid}_${Date.now()}`;

describePg('PG 真库回归：api_keys.id 默认值修复', () => {
  let dataSource: DataSource;
  let apiKeyService: ApiKeyService;
  let owner: User;

  const columnDefault = async (): Promise<string | null> => {
    const rows: Array<{ column_default: string | null }> = await dataSource.query(
      `SELECT column_default FROM information_schema.columns
       WHERE table_name = 'api_keys' AND column_name = 'id'`,
    );
    return rows[0]?.column_default ?? null;
  };

  const recreateFixMigrationScenario = async (): Promise<void> => {
    // 把库还原成"存量生产"形态：有表、迁移记录在但缺 DEFAULT 的历史快照无法伪造，
    // 因此等价模拟为——迁移链已执行过但该迁移不存在：删默认值 + 删迁移记录。
    await dataSource.query(`ALTER TABLE "api_keys" ALTER COLUMN "id" DROP DEFAULT`);
    await dataSource.query(`DELETE FROM migrations WHERE name = $1`, [FIX_MIGRATION_NAME]);
  };

  beforeAll(async () => {
    await admin.initialize();
    await admin.query(`CREATE DATABASE "${ISOLATED_DB}"`);

    dataSource = new DataSource(createDatabaseOptions({
      ...process.env,
      DB_TYPE: 'postgres',
      DB_DATABASE: ISOLATED_DB,
      DB_MIGRATIONS_RUN: 'false',
    }));
    await dataSource.initialize();
    await dataSource.runMigrations();

    const userRepo = dataSource.getRepository(User);
    owner = await userRepo.save(userRepo.create({
      email: `pgkeyit-${randomUUID()}@example.com`, password: 'hash',
    }));

    const audit = { log: jest.fn(), logAwait: jest.fn() } as never;
    apiKeyService = new ApiKeyService(
      dataSource.getRepository(ApiKey),
      userRepo,
      audit,
    );
  }, 120_000);

  afterAll(async () => {
    if (dataSource?.isInitialized) await dataSource.destroy();
    await admin.query(`DROP DATABASE IF EXISTS "${ISOLATED_DB}" WITH (FORCE)`).catch(() => undefined);
    await admin.destroy().catch(() => undefined);
  });

  it('空库完整迁移链后：真实 create 由数据库生成合法 UUID，摘要落库、明文不落库', async () => {
    expect(await columnDefault()).toMatch(/gen_random_uuid\(\)/);

    const created = await apiKeyService.create(owner, '回归密钥');
    expect(created.id).toMatch(UUID_RE);
    expect(created.key.startsWith('tgtc_')).toBe(true);
    expect(created.name).toBe('回归密钥');

    const row = await dataSource.getRepository(ApiKey).findOneByOrFail({ id: created.id });
    expect(row.keyHash).toBe(createHash('sha256').update(created.key, 'utf8').digest('hex'));
    expect(JSON.stringify(row)).not.toContain(created.key);
  });

  it('连续创建得到互不相同的 UUID，且轮换撤销旧密钥并创建同名新密钥', async () => {
    const first = await apiKeyService.create(owner);
    const second = await apiKeyService.create(owner);
    expect(first.id).toMatch(UUID_RE);
    expect(second.id).toMatch(UUID_RE);
    expect(first.id).not.toBe(second.id);

    const rotated = await apiKeyService.rotate(owner, first.id);
    expect(rotated.id).toMatch(UUID_RE);
    expect(rotated.id).not.toBe(first.id);
    expect(rotated.name).toBe(first.name);
    expect((await dataSource.getRepository(ApiKey).findOneByOrFail({ id: first.id })).revokedAt)
      .toBeInstanceOf(Date);
    expect((await dataSource.getRepository(ApiKey).findOneByOrFail({ id: rotated.id })).revokedAt)
      .toBeNull();
  });

  it('存量缺陷库升级：缺 DEFAULT 时插入复现 23502，补迁移后恢复且已有数据不变', async () => {
    const rowsBefore = await dataSource.getRepository(ApiKey).find();

    await recreateFixMigrationScenario();
    expect(await columnDefault()).toBeNull();
    // 复现生产故障：INSERT 省略 id → 非空约束（23502）
    await expect(apiKeyService.create(owner)).rejects.toMatchObject({ code: '23502' });
    // 已有密钥不受影响
    expect(await dataSource.getRepository(ApiKey).find()).toEqual(rowsBefore);

    // 与升级流程一致：应用启动迁移补齐缺口
    await dataSource.runMigrations();
    expect(await columnDefault()).toMatch(/gen_random_uuid\(\)/);
    const created = await apiKeyService.create(owner, '升级后创建');
    expect(created.id).toMatch(UUID_RE);
    expect(await dataSource.getRepository(ApiKey).find()).toHaveLength(rowsBefore.length + 1);
    expect(await dataSource.query('SELECT count(*) AS count FROM migrations WHERE name = $1', [FIX_MIGRATION_NAME]))
      .toEqual([{ count: '1' }]);
  });

  it('迁移回退只删默认值不删数据，重新 up 后恢复创建', async () => {
    await dataSource.undoLastMigration();
    expect(await columnDefault()).toBeNull();
    expect(await dataSource.getRepository(ApiKey).count()).toBeGreaterThan(0);

    await dataSource.runMigrations();
    expect(await columnDefault()).toMatch(/gen_random_uuid\(\)/);
    await expect(apiKeyService.create(owner)).resolves.toMatchObject({ id: expect.stringMatching(UUID_RE) });
  });
});
