import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
  OnModuleInit,
  Optional,
} from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { AlertLevel } from '../common/entities/alert.entity';
import { AlertEngineService } from '../alert/alert-engine.service';
import {
  GDriveBackendConfig,
  RemoteStorageBackendType,
  S3BackendConfig,
  StorageBackend,
  StorageBackendConfigPayload,
  WebDavBackendConfig,
} from '../common/entities/storage-backend.entity';
import { isDatabaseUniqueViolation } from '../database/database-types';
import { maskIdentifier } from '../telegram-accounts/telegram-account-view';
import { StorageAccountSchedulerService, StorageAttemptSample } from './storage-account-scheduler.service';
import { StorageCredentialService } from './storage-credential.service';
import { StorageDriverRegistry } from './storage-driver.registry';
import { StorageAccountContext, StorageQuota } from './storage.types';

/** 健康字段持久化节流：同一账号最多 30s 写一次（状态迁移除外，必须立即落库） */
const HEALTH_PERSIST_THROTTLE_MS = 30_000;

export interface CreateStorageBackendInput {
  type: RemoteStorageBackendType;
  name: string;
  config: StorageBackendConfigPayload;
  credential: Record<string, unknown>;
  weight?: number;
  maxInflight?: number;
  enabled?: boolean;
  note?: string;
}

export interface UpdateStorageBackendInput {
  name?: string;
  config?: StorageBackendConfigPayload;
  weight?: number;
  maxInflight?: number;
  enabled?: boolean;
  note?: string;
}

/** 脱敏视图：绝不包含 credentialCiphertext / 明文凭据 */
export interface StorageBackendView {
  id: string;
  type: RemoteStorageBackendType;
  name: string;
  status: string;
  enabled: boolean;
  weight: number;
  maxInflight: number;
  config: StorageBackendConfigPayload | null;
  hasCredential: boolean;
  quotaTotalBytes: number | null;
  quotaUsedBytes: number | null;
  lastQuotaCheckAt: Date | null;
  lastHealthCheckAt: Date | null;
  lastSuccessAt: Date | null;
  lastFailureAt: Date | null;
  lastFailureCode: string | null;
  lastFailureSummary: string | null;
  note: string | null;
  createdAt: Date;
  updatedAt: Date;
}

/** 按后端类型校验非敏感配置（入口 400，绝不把非法配置落库） */
export function validateBackendConfig(type: RemoteStorageBackendType, config: unknown): StorageBackendConfigPayload {
  if (!config || typeof config !== 'object') throw new BadRequestException('config 不能为空');
  const obj = config as Record<string, unknown>;
  if (type === 's3') {
    const bucket = String(obj.bucket ?? '').trim();
    const region = String(obj.region ?? '').trim();
    if (!bucket) throw new BadRequestException('S3 配置缺少 bucket');
    if (!region) throw new BadRequestException('S3 配置缺少 region');
    const endpoint = obj.endpoint === undefined || obj.endpoint === null ? '' : String(obj.endpoint).trim();
    if (endpoint && !/^https?:\/\//i.test(endpoint)) throw new BadRequestException('S3 endpoint 必须以 http(s):// 开头');
    const result: S3BackendConfig = { bucket, region };
    if (endpoint) result.endpoint = endpoint;
    if (obj.forcePathStyle !== undefined) result.forcePathStyle = Boolean(obj.forcePathStyle);
    if (obj.prefix !== undefined && obj.prefix !== null) {
      result.prefix = String(obj.prefix).replace(/^\/+|\/+$/g, '');
    }
    return result;
  }
  if (type === 'webdav') {
    const url = String(obj.url ?? '').trim();
    if (!/^https?:\/\//i.test(url)) throw new BadRequestException('WebDAV url 必须以 http(s):// 开头');
    const result: WebDavBackendConfig = { url: url.replace(/\/+$/, '') };
    if (obj.rootPath !== undefined && obj.rootPath !== null) {
      result.rootPath = String(obj.rootPath).replace(/^\/+|\/+$/g, '');
    }
    return result;
  }
  if (type === 'gdrive') {
    const result: GDriveBackendConfig = {};
    if (obj.rootFolderId) result.rootFolderId = String(obj.rootFolderId);
    if (obj.email) result.email = String(obj.email);
    return result;
  }
  throw new BadRequestException(`不支持的存储后端类型: ${type}`);
}

/** 按后端类型校验凭据载荷完整性（只校验存在性，错误信息不回显凭据值） */
export function validateBackendCredential(type: RemoteStorageBackendType, credential: unknown): Record<string, unknown> {
  if (!credential || typeof credential !== 'object') throw new BadRequestException('credential 不能为空');
  const obj = credential as Record<string, unknown>;
  const requireFields = (fields: string[]) => {
    for (const field of fields) {
      if (typeof obj[field] !== 'string' || !(obj[field] as string).trim()) {
        throw new BadRequestException(`凭据缺少必填字段 ${field}`);
      }
    }
  };
  if (type === 's3') requireFields(['accessKeyId', 'secretAccessKey']);
  else if (type === 'webdav') requireFields(['username', 'password']);
  else if (type === 'gdrive') requireFields(['refreshToken']);
  else throw new BadRequestException(`不支持的存储后端类型: ${type}`);
  return obj;
}

/**
 * 存储后端账号管理（事实来源 = storage_backends 表）。
 *
 * 职责：CRUD + 凭据加密托管 + 连通性测试 + 运行时上下文解析 + 健康/配额持久化。
 * 选号调度在 StorageAccountSchedulerService，传输编排在 StorageRouterService。
 *
 * 安全口径与 telegram-accounts 一致：创建即测试（失败不落库）、凭据只存密文、
 * 所有视图脱敏、撤销只清凭据停任务不删行（存量文件引用保持可诊断）。
 */
@Injectable()
export class StorageBackendsService implements OnModuleInit {
  private readonly logger = new Logger(StorageBackendsService.name);
  /** 解密上下文缓存（CRUD/轮换时失效；解密本身廉价，缓存只为省 DB 往返） */
  private readonly contextCache = new Map<string, StorageAccountContext>();
  private readonly healthPersistedAt = new Map<string, number>();

  constructor(
    @InjectRepository(StorageBackend)
    private readonly repo: Repository<StorageBackend>,
    private readonly credential: StorageCredentialService,
    private readonly scheduler: StorageAccountSchedulerService,
    private readonly registry: StorageDriverRegistry,
    // 告警引擎（可选依赖）：存储池容量耗尽时复用全站告警体系（与 BOT_POOL_* 同一模式）
    @Optional() private readonly alertEngine?: AlertEngineService,
  ) {}

  async onModuleInit(): Promise<void> {
    await this.refresh();
  }

  /** 以 DB 事实同步调度器注册表（CRUD / 启停 / 撤销后必须调用） */
  async refresh(): Promise<void> {
    const rows = await this.repo.find();
    this.scheduler.syncAccounts(rows);
    this.contextCache.clear();
  }

  async list(type?: RemoteStorageBackendType): Promise<StorageBackendView[]> {
    const rows = await this.repo.find({
      where: type ? { type } : {},
      order: { createdAt: 'ASC' },
    });
    return rows.map((row) => this.toView(row));
  }

  async detail(id: string): Promise<StorageBackendView> {
    return this.toView(await this.findOrFail(id));
  }

  async findById(id: string): Promise<StorageBackend | null> {
    return this.repo.findOne({ where: { id } });
  }

  /** 创建即连通性测试（与 TG 账号「创建即 getMe，失败不落库」同口径） */
  async create(input: CreateStorageBackendInput, adminId: string): Promise<StorageBackendView> {
    if (!this.credential.isAvailable()) {
      throw new BadRequestException(
        '未配置 STORAGE_ENCRYPTION_KEY（32 字节 base64/hex），无法加密保存凭据，拒绝创建存储账号',
      );
    }
    const driver = this.registry.get(input.type);
    if (!driver) throw new BadRequestException(`存储驱动未装配: ${input.type}`);
    const config = validateBackendConfig(input.type, input.config);
    const credentialPayload = validateBackendCredential(input.type, input.credential);
    const ciphertext = this.credential.encryptCredential(credentialPayload);
    if (!ciphertext) throw new BadRequestException('凭据加密失败，拒绝创建存储账号');

    const name = String(input.name ?? '').trim();
    if (!name || name.length > 64) throw new BadRequestException('name 必填且不超过 64 字符');

    // 先用明文上下文做连通性测试（此时尚未落库）；失败直接 400，不产生半成品账号
    const probeCtx: StorageAccountContext = {
      accountId: 'pending',
      type: input.type,
      config,
      credential: credentialPayload,
    };
    const probe = await driver.probeAccount(probeCtx);
    if (!probe.ok) {
      throw new BadRequestException(`存储端点连通性测试失败：${probe.error || '未知错误'}`);
    }

    const row = this.repo.create({
      type: input.type,
      name,
      config,
      status: 'active',
      enabled: input.enabled !== false,
      weight: Math.max(1, Math.floor(input.weight ?? 1)),
      maxInflight: Math.max(1, Math.floor(input.maxInflight ?? 8)),
      credentialCiphertext: ciphertext,
      credentialVersion: this.credential.cipherVersion(),
      lastHealthCheckAt: new Date(),
      lastSuccessAt: new Date(),
      note: input.note?.slice(0, 255) ?? null,
      createdBy: adminId,
      updatedBy: adminId,
    });
    try {
      const saved = await this.repo.save(row);
      await this.refresh();
      // GDrive 创建成功后立即拉一次配额（个人账号 15GB，调度硬准入依赖它）
      if (input.type === 'gdrive') {
        await this.refreshQuota(saved.id).catch(() => {});
      }
      return this.toView(saved);
    } catch (error) {
      if (isDatabaseUniqueViolation(error)) {
        throw new BadRequestException('同一后端类型下已存在同名账号');
      }
      throw error;
    }
  }

  async update(id: string, input: UpdateStorageBackendInput, adminId: string): Promise<StorageBackendView> {
    const row = await this.findOrFail(id);
    if (row.status === 'revoked') throw new BadRequestException('账号已撤销，请先轮换凭据重新启用');
    if (input.name !== undefined) {
      const name = String(input.name).trim();
      if (!name || name.length > 64) throw new BadRequestException('name 必填且不超过 64 字符');
      row.name = name;
    }
    if (input.config !== undefined) {
      const nextConfig = validateBackendConfig(row.type, input.config);
      if (this.storageLocationChanged(row.type, row.config ?? {}, nextConfig)) {
        throw new BadRequestException('不能在现有账号上更改存储位置；请新建存储账号并迁移对象');
      }
      row.config = row.type === 'gdrive'
        ? {
          ...((row.config as GDriveBackendConfig | null) ?? {}),
          ...(nextConfig as GDriveBackendConfig),
        }
        : nextConfig;
    }
    if (input.weight !== undefined) row.weight = Math.max(1, Math.floor(input.weight));
    if (input.maxInflight !== undefined) row.maxInflight = Math.max(1, Math.floor(input.maxInflight));
    if (input.note !== undefined) row.note = input.note?.slice(0, 255) ?? null;
    if (input.enabled !== undefined) {
      row.enabled = Boolean(input.enabled);
      // 启停与状态机联动：停用 → disabled；重新启用且原因为停用 → active
      if (!row.enabled) row.status = 'disabled';
      else if (row.status === 'disabled') row.status = 'active';
    }
    row.updatedBy = adminId;
    try {
      const saved = await this.repo.save(row);
      await this.refresh();
      return this.toView(saved);
    } catch (error) {
      if (isDatabaseUniqueViolation(error)) {
        throw new BadRequestException('同一后端类型下已存在同名账号');
      }
      throw error;
    }
  }

  /** 已有文件只保存账号 ID 和相对对象引用，不能在原账号上改变实际存储位置。 */
  private storageLocationChanged(
    type: RemoteStorageBackendType,
    previousConfig: StorageBackendConfigPayload | Record<string, unknown>,
    nextConfig: StorageBackendConfigPayload,
  ): boolean {
    if (type === 's3') {
      const previous = previousConfig as Partial<S3BackendConfig>;
      const next = nextConfig as S3BackendConfig;
      const normalizeEndpoint = (value?: string) => (value ?? '').trim().replace(/\/+$/, '');
      const normalizePrefix = (value?: string) => (value ?? '').replace(/^\/+|\/+$/g, '');
      return previous.bucket !== next.bucket
        || previous.region !== next.region
        || normalizeEndpoint(previous.endpoint) !== normalizeEndpoint(next.endpoint)
        || normalizePrefix(previous.prefix) !== normalizePrefix(next.prefix);
    }
    if (type === 'webdav') {
      const previous = previousConfig as Partial<WebDavBackendConfig>;
      const next = nextConfig as WebDavBackendConfig;
      return previous.url !== next.url || (previous.rootPath ?? '') !== (next.rootPath ?? '');
    }
    return false;
  }

  /** 轮换凭据（撤销账号凭此重新启用）；同样先测试后落库 */
  async rotateCredential(id: string, credentialPayload: Record<string, unknown>, adminId: string): Promise<StorageBackendView> {
    if (!this.credential.isAvailable()) {
      throw new BadRequestException('未配置 STORAGE_ENCRYPTION_KEY，无法加密保存凭据，拒绝轮换');
    }
    const row = await this.findOrFail(id);
    const driver = this.registry.get(row.type);
    if (!driver) throw new BadRequestException(`存储驱动未装配: ${row.type}`);
    const validated = validateBackendCredential(row.type, credentialPayload);
    const probe = await driver.probeAccount({
      accountId: row.id,
      type: row.type,
      config: row.config ?? {},
      credential: validated,
    });
    if (!probe.ok) throw new BadRequestException(`新凭据连通性测试失败：${probe.error || '未知错误'}`);
    const ciphertext = this.credential.encryptCredential(validated);
    if (!ciphertext) throw new BadRequestException('凭据加密失败，拒绝轮换');
    row.credentialCiphertext = ciphertext;
    row.credentialVersion = this.credential.cipherVersion();
    if (row.status === 'revoked') {
      row.enabled = true;
      row.status = 'active';
    } else if (row.status === 'disabled' || !row.enabled) {
      row.enabled = false;
      row.status = 'disabled';
    } else {
      row.status = 'active';
    }
    row.lastFailureCode = null;
    row.lastFailureSummary = null;
    row.updatedBy = adminId;
    const saved = await this.repo.save(row);
    await this.refresh();
    return this.toView(saved);
  }

  /**
   * 撤销账号：清空凭据、停止参与新任务，但**保留行**——存量文件仍引用该账号，
   * 回源侧按 fail-closed 返回可诊断失败（绝不跨账号猜测，也绝不静默丢文件）。
   */
  async revoke(id: string, adminId: string): Promise<StorageBackendView> {
    const row = await this.findOrFail(id);
    row.status = 'revoked';
    row.enabled = false;
    row.credentialCiphertext = null;
    row.updatedBy = adminId;
    const saved = await this.repo.save(row);
    await this.refresh();
    return this.toView(saved);
  }

  /** 连通性测试（结论写入健康字段；GDrive 顺带刷新配额） */
  async test(id: string): Promise<{ view: StorageBackendView; probe: { ok: boolean; latencyMs?: number; error?: string } }> {
    const row = await this.findOrFail(id);
    const driver = this.registry.get(row.type);
    if (!driver) throw new BadRequestException(`存储驱动未装配: ${row.type}`);
    const ctx = await this.resolveContext(id);
    if (!ctx) {
      await this.markDegraded(id, 'credential_unavailable', '凭据不可解密（根密钥缺失或已变更）');
      throw new BadRequestException('凭据不可用：请检查 STORAGE_ENCRYPTION_KEY 或轮换凭据');
    }
    const probe = await driver.probeAccount(ctx);
    const now = new Date();
    row.lastHealthCheckAt = now;
    if (probe.ok) {
      row.lastSuccessAt = now;
      if (row.status === 'degraded') row.status = 'active';
    } else {
      row.lastFailureAt = now;
      row.lastFailureCode = 'probe_failed';
      row.lastFailureSummary = (probe.error || '未知错误').slice(0, 500);
    }
    await this.repo.save(row);
    await this.refresh();
    if (probe.ok && row.type === 'gdrive') {
      await this.refreshQuota(id).catch(() => {});
    }
    return { view: this.toView(await this.findOrFail(id)), probe };
  }

  /**
   * 解析账号执行上下文（含解密凭据）。凭据不可用时返回 null 并把账号标记 degraded，
   * 调用方按「凭据不可用」处理（fail-closed，绝不抛可泄露信息的异常）。
   */
  async resolveContext(accountId: string): Promise<StorageAccountContext | null> {
    const cached = this.contextCache.get(accountId);
    if (cached) return cached;
    const row = await this.repo.findOne({
      where: { id: accountId },
      select: ['id', 'type', 'config', 'status', 'credentialCiphertext'],
    });
    if (!row || row.status === 'revoked' || !row.credentialCiphertext) return null;
    const credential = this.credential.decryptCredential<Record<string, unknown>>(row.credentialCiphertext);
    if (!credential) {
      await this.markDegraded(accountId, 'credential_unavailable', '凭据解密失败（根密钥变更或密文损坏）');
      return null;
    }
    const ctx: StorageAccountContext = {
      accountId: row.id,
      type: row.type,
      config: row.config ?? {},
      credential,
    };
    this.contextCache.set(accountId, ctx);
    return ctx;
  }

  /** 刷新账号配额（驱动支持时），写 DB + 调度器 */
  async refreshQuota(accountId: string): Promise<StorageQuota | null> {
    const row = await this.findById(accountId);
    if (!row) return null;
    const driver = this.registry.get(row.type);
    if (!driver?.getQuota) return null;
    const ctx = await this.resolveContext(accountId);
    if (!ctx) return null;
    const quota = await driver.getQuota(ctx);
    this.scheduler.updateQuota(accountId, quota);
    await this.repo.update(accountId, {
      quotaTotalBytes: quota.totalBytes,
      quotaUsedBytes: quota.usedBytes,
      lastQuotaCheckAt: new Date(),
    });
    return quota;
  }

  /**
   * 传输结果持久化（节流 30s；auth 失败立即转 degraded 并落库）。
   * 由 StorageRouterService 在每次尝试结束后调用，best-effort 绝不影响传输结论。
   */
  async recordOutcome(accountId: string, sample: StorageAttemptSample): Promise<void> {
    try {
      const now = Date.now();
      const isAuthFailure = !sample.ok && sample.failureKind === 'auth';
      const last = this.healthPersistedAt.get(accountId) ?? 0;
      if (!isAuthFailure && now - last < HEALTH_PERSIST_THROTTLE_MS) return;
      this.healthPersistedAt.set(accountId, now);
      if (sample.ok) {
        await this.repo.update(accountId, { lastSuccessAt: new Date() });
        return;
      }
      const patch: Partial<StorageBackend> = {
        lastFailureAt: new Date(),
        lastFailureCode: sample.failureKind ?? 'other',
        lastFailureSummary: this.safeSummary(sample.errorMessage),
      };
      if (isAuthFailure) {
        patch.status = 'degraded';
        await this.repo.update({ id: accountId, status: 'active' }, patch);
        await this.refresh();
        this.logger.warn(`存储账号 ${maskIdentifier(accountId)} 凭据类失败，已转 degraded（需管理员检查/轮换）`);
        return;
      }
      await this.repo.update(accountId, patch);
    } catch (error) {
      this.logger.debug(`存储账号健康持久化失败（不影响传输）：${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /** 驱动侧配置回填（如 GDrive 首次上传创建的根文件夹 ID）；best-effort，失败不影响传输 */
  async patchConfig(accountId: string, patch: Record<string, unknown>): Promise<void> {
    try {
      const row = await this.findById(accountId);
      if (!row) return;
      row.config = { ...(row.config ?? {}), ...patch } as StorageBackendConfigPayload;
      await this.repo.save(row);
      // 同步内存上下文（resolveContext 缓存与 DB 保持一致）
      const cached = this.contextCache.get(accountId);
      if (cached) cached.config = row.config as StorageAccountContext['config'];
    } catch (error) {
      this.logger.debug(`存储账号配置回填失败（不影响传输）：${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * 配额定时刷新（每 30 分钟）：GDrive 个人账号 15GB，调度硬准入依赖最新剩余空间；
   * 其它账号在 Drive 侧删除文件释放的空间也能被及时发现。失败只告警不阻断。
   */
  @Cron('0 */30 * * * *')
  async refreshQuotaCron(): Promise<void> {
    const rows = await this.repo.find({ where: { type: 'gdrive', enabled: true } });
    for (const row of rows) {
      if (row.status !== 'active') continue;
      try {
        await this.refreshQuota(row.id);
      } catch (error) {
        this.logger.warn(
          `GDrive 账号 ${maskIdentifier(row.id)} 配额刷新失败：${error instanceof Error ? error.message.slice(0, 120) : String(error)}`,
        );
      }
    }
    // 全部可用账号配额耗尽告警（上传侧会返回可重试 503，这里保证管理端可感知）
    const active = this.scheduler.activeAccountIds('gdrive');
    if (rows.length > 0 && active.length > 0) {
      const schedulable = this.scheduler.select('gdrive', Date.now(), { requiredBytes: 1 });
      if (!schedulable) {
        this.logger.warn('GDrive 存储池当前无可用容量（全部账号配额耗尽或冷却），新上传将返回可重试 503，请扩容账号或清理空间');
        await this.raiseCapacityExhaustedAlert('gdrive', active.length);
      }
    }
  }

  /**
   * 存储池容量耗尽告警（复用 AlertEngineService，与 BOT_POOL_ALL_UNAVAILABLE 同一模式）。
   * 引擎内置原子冷却去重（30 分钟），重复触发不会刷屏；best-effort，失败只告警不阻断。
   */
  async raiseCapacityExhaustedAlert(backendType: string, activeAccounts: number): Promise<void> {
    if (!this.alertEngine) return;
    try {
      await this.alertEngine.createAlerts([{
        ruleId: 'STORAGE_CAPACITY_EXHAUSTED',
        level: AlertLevel.CRITICAL,
        title: '存储池容量耗尽',
        message: `${backendType} 存储池当前无可用容量（${activeAccounts} 个启用账号全部配额耗尽或冷却），新上传将返回可重试 503；请添加账号扩容或清理远端空间`,
        context: { backendType, activeAccounts },
      }]);
    } catch (error) {
      this.logger.warn(`存储容量告警创建失败（忽略）：${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /** 管理端总览：各类型账号计数 + 调度快照（脱敏） */
  async overview(): Promise<{
    accounts: StorageBackendView[];
    scheduler: ReturnType<StorageAccountSchedulerService['snapshot']>;
    driverTypes: RemoteStorageBackendType[];
    credentialAvailable: boolean;
  }> {
    return {
      accounts: await this.list(),
      scheduler: this.scheduler.snapshot(),
      driverTypes: this.registry.types(),
      credentialAvailable: this.credential.isAvailable(),
    };
  }

  toView(row: StorageBackend): StorageBackendView {
    const config = row.config ? { ...row.config } as StorageBackendConfigPayload : null;
    // GDrive 邮箱脱敏（保留首字符与域名）
    if (config && row.type === 'gdrive' && (config as GDriveBackendConfig).email) {
      const email = (config as GDriveBackendConfig).email!;
      const [local, domain] = email.split('@');
      (config as GDriveBackendConfig).email = domain
        ? `${local.slice(0, 1)}***@${domain}`
        : '***';
    }
    return {
      id: row.id,
      type: row.type,
      name: row.name,
      status: row.status,
      enabled: row.enabled,
      weight: row.weight,
      maxInflight: row.maxInflight,
      config,
      // 密文列 select:false 默认不加载；撤销时已清空凭据，故以状态判定
      hasCredential: row.status !== 'revoked',
      quotaTotalBytes: row.quotaTotalBytes === null ? null : Number(row.quotaTotalBytes),
      quotaUsedBytes: row.quotaUsedBytes === null ? null : Number(row.quotaUsedBytes),
      lastQuotaCheckAt: row.lastQuotaCheckAt,
      lastHealthCheckAt: row.lastHealthCheckAt,
      lastSuccessAt: row.lastSuccessAt,
      lastFailureAt: row.lastFailureAt,
      lastFailureCode: row.lastFailureCode,
      lastFailureSummary: row.lastFailureSummary,
      note: row.note,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }

  private async findOrFail(id: string): Promise<StorageBackend> {
    const row = await this.repo.findOne({ where: { id } });
    if (!row) throw new NotFoundException('存储账号不存在');
    return row;
  }

  private async markDegraded(accountId: string, code: string, summary: string): Promise<void> {
    await this.repo.update({ id: accountId, status: 'active' }, {
      status: 'degraded',
      lastFailureAt: new Date(),
      lastFailureCode: code,
      lastFailureSummary: summary.slice(0, 500),
    });
    await this.refresh();
  }

  /** 失败摘要安全化：去控制字符、限长（调用方已保证不含凭据，这里兜底） */
  private safeSummary(message?: string): string | null {
    if (!message) return null;
    return message
      .replace(/[\u0000-\u001F\u007F]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 500) || null;
  }
}
