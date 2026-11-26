import 'reflect-metadata';
import { Test, TestingModule } from '@nestjs/testing';

/**
 * 生产模块图的**启动期装配门禁**（容器级）。
 *
 * ## 为什么必须有这一层
 *
 * 2026-11 的真实事故：`UserPreferredDownloadService` 注册在 `TelegramAccountPoolModule`，
 * 却注入了 `TelegramMirrorModule` 的 `TelegramMainChatAnchorService`。结果
 *
 * ```
 * Nest can't resolve dependencies of the UserPreferredDownloadService
 * (..., TelegramMainChatAnchorService at index [2])
 * ```
 *
 * 进程启动即崩、auto-restart 循环，而当时 **typecheck ✅ / backend build ✅ /
 * 1808 个单测全绿**。漏检原因很具体：
 * - 类型检查只看「类的形状」，不看「模块图里谁导出了该 token」；
 * - 单测普遍 `new Service(...)`，直接绕过容器。
 *
 * 因此唯一可信的判据是**编译真实 `AppModule`**：只要有任何 provider 的依赖
 * 在它所属模块作用域内不可解析，Nest 就会在 `compile()` 阶段抛错。
 *
 * ## 边界（刻意的取舍）
 *
 * - 只 `compile()`，**不 `init()`**：不触发轮询、定时器、webhook 注册等副作用；
 * - 用 SQLite `:memory:` + 不可达 Redis 端口：不依赖任何外部服务，可离线运行；
 * - 模块加载发生在 `beforeAll` 设置环境变量**之后**（动态 import），
 *   因为 `createDatabaseOptions()` 在 `@Module` 装饰器求值时就会读取 env；
 * - 只证明「依赖能解析」，不证明「业务正确」——后者由各自的行为用例覆盖。
 *
 * 成本约 4 秒，换来的是「部署前必然发现启动崩溃」。
 */
describe('AppModule 启动期装配（真实容器编译）', () => {
  const ENV_KEYS = [
    'DB_TYPE',
    'DB_DATABASE',
    'DB_MIGRATIONS_RUN',
    'JWT_SECRET',
    'REDIS_HOST',
    'REDIS_PORT',
    'TELEGRAM_BOT_TOKEN',
    'TELEGRAM_ACCOUNT_POOL_ENABLED',
  ] as const;
  let snapshot: Record<string, string | undefined>;
  let moduleRef: TestingModule | null = null;

  beforeAll(() => {
    snapshot = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
    process.env.DB_TYPE = 'sqlite';
    process.env.DB_DATABASE = ':memory:';
    process.env.DB_MIGRATIONS_RUN = 'false';
    process.env.JWT_SECRET = 'di-boot-probe-secret';
    // 指向不可达端口：Bull 的连接尝试会失败但不会阻塞 compile()，也不碰真实 Redis
    process.env.REDIS_HOST = '127.0.0.1';
    process.env.REDIS_PORT = '1';
    // 账号池默认关闭：本用例只验证装配，不验证启用态
    process.env.TELEGRAM_ACCOUNT_POOL_ENABLED = 'false';
  }, 30_000);

  afterAll(async () => {
    await moduleRef?.close();
    moduleRef = null;
    for (const key of ENV_KEYS) {
      if (snapshot[key] === undefined) delete process.env[key];
      else process.env[key] = snapshot[key];
    }
  }, 30_000);

  it('编译 AppModule：全部 provider 的依赖在其模块作用域内可解析', async () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { AppModule } = require('./app.module') as typeof import('./app.module');

    moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();

    expect(moduleRef).toBeDefined();
  }, 60_000);

  it('下载优先 user 账号服务在真实容器中可解析，且默认关闭（30 天回退语义）', async () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { UserPreferredDownloadService } =
      require('./file/user-preferred-download.service') as typeof import('./file/user-preferred-download.service');

    // 该实例由容器注入，5 个构造依赖（含跨模块的锚点服务与全局预算）均已解析；
    // 修复前这里根本走不到——容器编译会先抛「can't resolve dependencies」。
    const service = moduleRef!.get(UserPreferredDownloadService);
    expect(service).toBeInstanceOf(UserPreferredDownloadService);
    expect(service.isEnabled()).toBe(false);
  }, 30_000);
});
