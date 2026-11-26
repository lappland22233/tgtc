import 'reflect-metadata';
import { MODULE_METADATA } from '@nestjs/common/constants';
import { Type } from '@nestjs/common';
import { File } from '../common/entities/file.entity';
import { Folder } from '../common/entities/folder.entity';
import { FileAccessLog } from '../common/entities/file-access-log.entity';
import { ShareAudit } from '../common/entities/share-audit.entity';
import { ShareLink } from '../common/entities/share-link.entity';
import { UploadTask } from '../common/entities/upload-task.entity';
import { TelegramFileCopy } from '../common/entities/telegram-file-copy.entity';
import { TelegramAccount } from '../common/entities/telegram-account.entity';
import { TelegramMirrorRule } from '../common/entities/telegram-mirror-rule.entity';
import { TelegramMirrorTask } from '../common/entities/telegram-mirror-task.entity';
import { TelegramReplicationAttempt } from '../common/entities/telegram-replication-attempt.entity';
import { TelegramMainChatAnchor } from '../common/entities/telegram-main-chat-anchor.entity';
import { TelegramBotFileGrant } from '../common/entities/telegram-bot-file-grant.entity';
import { TelegramAccountPoolModule } from '../telegram-account-pool/telegram-account-pool.module';
import { TelegramMirrorModule } from '../telegram-mirror/telegram-mirror.module';
import { UserPreferredDownloadService } from './user-preferred-download.service';
import { FileModule } from './file.module';

/**
 * 模块图装配的**静态守卫**（防止「类型检查通过、单测全绿、启动即崩」）。
 *
 * ## 回归背景（真实生产事故）
 *
 * `UserPreferredDownloadService` 原注册在 `TelegramAccountPoolModule`，却注入了
 * `TelegramMirrorModule` 里的 `TelegramMainChatAnchorService`。账号池模块没有
 * import 镜像模块（**也不能**——镜像模块已 import 账号池，反向即环），于是
 * Nest 在启动期直接抛 `Nest can't resolve dependencies of the
 * UserPreferredDownloadService (..., TelegramMainChatAnchorService at index [2])`，
 * 服务陷入 auto-restart。
 *
 * 为什么现有测试全部漏掉：
 * - 类型检查只验证「类的形状」，不验证「模块图里谁导出了它」；
 * - 单测直接 `new Service(...)`，绕过了整个容器。
 *
 * ## 守卫做什么
 *
 * 从产品 `@Module` 元数据出发，对指定模块做**传递闭包**，收集它在运行期真实可见的
 * 注入 token（自提供 + 导出 + 全局模块导出），然后断言目标类的构造函数依赖全部可达。
 * 不启动 Nest 应用、不连数据库 / Redis / Telegram，因此是纯静态、毫秒级。
 *
 * 边界：只判「token 是否可达」，不判「值是否已启用」——后者由行为用例覆盖。
 */

/** 运行时可见的注入 token 集合 */
interface Visibility {
  /** 本模块作用域内可解析的 token（含全局模块导出与传递导入的导出） */
  tokens: Set<unknown>;
  /** 全局模块的导出（所有作用域可见） */
  globalTokens: Set<unknown>;
}

const GLOBAL_MODULE_METADATA = '__module:global__';

/** TypeORM 实体表名 → 实体类（`forFeature` 生成的仓库按表名归属） */
const KNOWN_ENTITIES = new Map<string, Type<unknown>>([
  ['files', File],
  ['folders', Folder],
  ['file_access_logs', FileAccessLog],
  ['share_audits', ShareAudit],
  ['share_links', ShareLink],
  ['upload_tasks', UploadTask],
  ['telegram_file_copies', TelegramFileCopy],
  ['telegram_accounts', TelegramAccount],
  ['telegram_mirror_rules', TelegramMirrorRule],
  ['telegram_mirror_tasks', TelegramMirrorTask],
  ['telegram_replication_attempts', TelegramReplicationAttempt],
  ['telegram_main_chat_anchors', TelegramMainChatAnchor],
  ['telegram_bot_file_grants', TelegramBotFileGrant],
]);

function moduleMeta(key: string, target: Type<unknown>): unknown[] {
  return (Reflect.getMetadata(key, target) ?? []) as unknown[];
}

function isDynamicModule(value: unknown): value is { module: Type<unknown>; providers?: unknown[]; exports?: unknown[]; imports?: unknown[] } {
  return typeof value === 'object' && value !== null && 'module' in value;
}

/**
 * 收集 provider 的 token（类 provider 与 { provide } 形式）。
 *
 * TypeORM 的 `forFeature` 生成的是字符串 token（`TelegramMainChatAnchorRepository`），
 * 而注入侧写的是 `@InjectRepository(Entity)`。二者是同一件事，这里把实体类也一并登记，
 * 否则「仓库明明导出了却被判不可达」。判定依据是 provider 自带的 `targetEntitySchema`。
 */
function providerTokens(providers: unknown[]): unknown[] {
  const tokens: unknown[] = [];
  for (const p of providers) {
    if (typeof p === 'function') {
      tokens.push(p);
      continue;
    }
    if (!p || typeof p !== 'object' || !('provide' in p)) continue;
    tokens.push((p as { provide: unknown }).provide);
    const schema = (p as { targetEntitySchema?: { name?: string } }).targetEntitySchema;
    const entityName = schema?.name;
    if (!entityName) continue;
    // 实体类只在本文件已导入时才能按引用登记；用名字回退到已知实体表
    const entity = KNOWN_ENTITIES.get(entityName);
    if (entity) tokens.push(entity);
  }
  return tokens;
}

/**
 * 求模块对**外部消费者**导出的 token（`exports` 语义）。
 *
 * 这是本守卫的核心：Nest 的可注入可见性严格遵循「只继承导入模块的 exports」，
 * 而不是「导入模块内部能看到的一切」。写成后者会让守卫失效——
 * 例如账号池模块导入了 `TelegramUserModule`，若整体并入其内部可见集，
 * 则任何导入账号池的模块都会「看似」拿到 `TelegramUserClientService`，
 * 于是真正的装配缺陷被掩盖（本次 mutation 验证正是这样抓到算法过宽）。
 *
 * 语义：
 * - `exports` 里的 provider 类 → 该 token 可见；
 * - `exports` 里的模块类 → 它是**再导出**，递归并入该模块的 exports；
 * - 动态模块（forFeature / registerQueue）→ 其 `exports` 数组即对父模块可见的部分。
 */
function exportedTokens(
  target: unknown,
  seen: Set<unknown> = new Set(),
): Set<unknown> {
  const tokens = new Set<unknown>();
  if (!target || (typeof target !== 'function' && typeof target !== 'object')) return tokens;
  if (seen.has(target)) return tokens;
  seen.add(target);

  if (isDynamicModule(target)) {
    for (const token of providerTokens(target.exports ?? [])) tokens.add(token);
    // 动态模块自身也可能带静态 exports 元数据
    for (const entry of moduleMeta(MODULE_METADATA.EXPORTS, target.module)) {
      for (const token of exportedTokens(entry, seen)) tokens.add(token);
    }
    return tokens;
  }

  for (const entry of moduleMeta(MODULE_METADATA.EXPORTS, target as Type<unknown>)) {
    if (typeof entry === 'function' && Reflect.getMetadata(MODULE_METADATA.IMPORTS, entry) !== undefined) {
      // 再导出一个模块：并入它的 exports
      for (const token of exportedTokens(entry, seen)) tokens.add(token);
      continue;
    }
    for (const token of providerTokens([entry])) tokens.add(token);
  }
  return tokens;
}

/**
 * 求模块作用域内**可注入**的 token 集合。
 *
 * `自提供 providers ∪ 各直接导入模块的 exports ∪ 全局模块 exports`。
 * 不做「导入模块内部可见集」的整体并入——那会掩盖真实的装配缺陷。
 */
function visibleTokens(
  target: Type<unknown>,
  globalTokens: Set<unknown> = new Set(),
): Visibility {
  const tokens = new Set<unknown>(globalTokens);

  for (const token of providerTokens(moduleMeta(MODULE_METADATA.PROVIDERS, target))) tokens.add(token);
  // 自身导出的 token 也必然自提供（或再导出），纳入以覆盖 `exports` 简化写法
  for (const token of exportedTokens(target)) tokens.add(token);

  for (const imported of moduleMeta(MODULE_METADATA.IMPORTS, target)) {
    for (const token of exportedTokens(imported)) tokens.add(token);
  }

  return { tokens, globalTokens };
}

/** 全局模块的导出 token（@Global 模块对全部作用域可见） */
function collectGlobalTokens(): Set<unknown> {
  // 只登记本仓库已知的全局模块（避免扫描全量文件系统）：
  // ConfigCacheModule / ConfigModule / MailerModule / AuditModule / RateLimitModule /
  // StreamResponderModule / MediaTicketModule / DirectoryNamespaceModule /
  // AccessLogModule / SecurityModule / TelegramModule
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const globals: Array<Type<unknown>> = [
    require('../common/services/config-cache.module').ConfigCacheModule,
    require('../common/services/audit.module').AuditModule,
    require('../common/services/rate-limit.module').RateLimitModule,
    require('../common/services/stream-responder.module').StreamResponderModule,
    require('../common/services/media-ticket.module').MediaTicketModule,
    require('../common/services/directory-namespace.module').DirectoryNamespaceModule,
    require('../common/access-log.module').AccessLogModule,
    require('../mailer/mailer.module').MailerModule,
    require('../security/security.module').SecurityModule,
    require('../telegram/telegram.module').TelegramModule,
    require('../config/config.module').AppConfigModule,
  ];
  const tokens = new Set<unknown>();
  for (const mod of globals) {
    if (Reflect.getMetadata(GLOBAL_MODULE_METADATA, mod) !== true) continue;
    for (const token of providerTokens(moduleMeta(MODULE_METADATA.EXPORTS, mod))) tokens.add(token);
    // 全局模块自身提供的 TypeOrmModule.forFeature 仓库
    for (const imported of moduleMeta(MODULE_METADATA.IMPORTS, mod)) {
      if (!isDynamicModule(imported)) continue;
      for (const token of providerTokens(imported.exports ?? [])) tokens.add(token);
    }
  }
  return tokens;
}

/**
 * 声明式依赖清单：`design:paramtypes` 在这里不可靠。
 *
 * 原因：`strictPropertyInitialization: false` 与 `isolatedModules` 下，某些接口类型
 * 会退化为 `Object`；而本仓库大量使用 `@Optional() @Inject(X)` 显式 token。
 * 因此优先读 `self:paramtypes`（`@Inject` 写入的真实 token），回退到 `design:paramtypes`。
 */
function declaredDeps(target: Type<unknown>): unknown[] {
  const explicit = new Map<number, unknown>();
  const selfDeclared = (Reflect.getMetadata('self:paramtypes', target) ?? []) as Array<{ index: number; param: unknown }>;
  for (const entry of selfDeclared) explicit.set(entry.index, entry.param);

  const paramtypes = (Reflect.getMetadata('design:paramtypes', target) ?? []) as unknown[];
  const count = Math.max(paramtypes.length, ...Array.from(explicit.keys()).map((i) => i + 1), 0);
  const deps: unknown[] = [];
  for (let i = 0; i < count; i += 1) deps.push(explicit.has(i) ? explicit.get(i) : paramtypes[i]);
  return deps;
}

/** 内置 token：Nest 运行时提供，不属于任何模块 provider */
function isBuiltinToken(token: unknown): boolean {
  return token === undefined || token === Object
    // SchedulerRegistry / HttpAdapterHost 等由框架注入；本仓库当前未使用，保留白名单位
    || token === Reflect;
}

describe('模块图装配守卫：关键跨模块依赖必须可达', () => {
  it('FileModule 能解析 UserPreferredDownloadService 的全部构造依赖', () => {
    const globalTokens = collectGlobalTokens();
    const { tokens } = visibleTokens(FileModule, globalTokens);

    const deps = declaredDeps(UserPreferredDownloadService);
    expect(deps.length).toBeGreaterThan(0);

    const missing = deps
      .filter((dep) => !isBuiltinToken(dep))
      .filter((dep) => !tokens.has(dep))
      .map((dep) => (typeof dep === 'function' ? (dep as Type<unknown>).name : String(dep)));

    // 事故复现点：`TelegramMainChatAnchorService` 必须在 FileModule 作用域内可见。
    // 修复前它不可见（服务在账号池模块，而账号池无法反向 import 镜像模块）。
    expect(missing).toEqual([]);
  });

  it('UserPreferredDownloadService 已不在账号池模块注册（否则依赖仍不可达）', () => {
    const providers = providerTokens(moduleMeta(MODULE_METADATA.PROVIDERS, TelegramAccountPoolModule));
    expect(providers).not.toContain(UserPreferredDownloadService);
  });

  it('TelegramMirrorModule 导出主群锚点服务（下载链路的唯一只读来源）', () => {
    const exportsList = providerTokens(moduleMeta(MODULE_METADATA.EXPORTS, TelegramMirrorModule));
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { TelegramMainChatAnchorService } = require('../telegram-mirror/telegram-main-chat-anchor.service');
    expect(exportsList).toContain(TelegramMainChatAnchorService);
  });

  it('FileModule 导入的用户账号模块确实导出了 TelegramUserClientService', () => {
    const { tokens } = visibleTokens(FileModule, collectGlobalTokens());
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { TelegramUserClientService } = require('../telegram-user/telegram-user-client.service');
    expect(tokens.has(TelegramUserClientService)).toBe(true);
  });

  it('锚点服务自身的仓库依赖在镜像模块内可达', () => {
    const { tokens } = visibleTokens(TelegramMirrorModule, collectGlobalTokens());
    // 只断言仓库 token（其余为 @Optional，缺失时可降级）
    expect(tokens.has(TelegramMainChatAnchor)).toBe(true);
    expect(tokens.has(TelegramMirrorRule)).toBe(true);
    expect(tokens.has(File)).toBe(true);
    expect(tokens.has(TelegramBotFileGrant)).toBe(true);
    expect(tokens.has(TelegramMirrorTask)).toBe(true);
  });

  it('账号池模块作用域内看不到锚点服务——这正是本服务不能注册在那里、必须归属 FileModule 的原因', () => {
    const { tokens } = visibleTokens(TelegramAccountPoolModule, collectGlobalTokens());
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { TelegramMainChatAnchorService } = require('../telegram-mirror/telegram-main-chat-anchor.service');

    // 镜像模块 import 了账号池模块；账号池若反向 import 镜像即形成模块环。
    // 因此锚点服务对账号池作用域**永远不可见**：把 UserPreferredDownloadService
    // 放回账号池，Nest 必然在启动期抛「can't resolve dependencies」。
    expect(tokens.has(TelegramMainChatAnchorService)).toBe(false);
  });

  it('账号池模块的仓库依赖自洽（防止同样的图缺陷）', () => {
    const { tokens } = visibleTokens(TelegramAccountPoolModule, collectGlobalTokens());
    expect(tokens.has(TelegramFileCopy)).toBe(true);
    expect(tokens.has(TelegramAccount)).toBe(true);
    expect(tokens.has(File)).toBe(true);
    expect(tokens.has(TelegramMirrorRule)).toBe(true);
    expect(tokens.has(TelegramReplicationAttempt)).toBe(true);
  });
});
