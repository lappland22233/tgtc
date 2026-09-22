import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

/** MTProto 客户端模块候选：优先使用维护中的 teleproto，兼容已归档的 gramjs */
const CLIENT_MODULE_CANDIDATES = ['teleproto', 'telegram'] as const;

/** 单次 MTProto 操作的整体超时（连接 + 调用），避免网络卡死时请求悬挂 */
const DEFAULT_TIMEOUT_MS = 60_000;

/** teleproto Logger 的 `none` 级别（该包未从主入口导出 LogLevel 枚举，故用字面量） */
const MT_PROTO_LOG_LEVEL_NONE = 'none';

/**
 * 兜底静默 logger（不打印任何 MTProto 会话/协议日志）。
 *
 * 只有在模块未导出 `Logger` 时才使用，因此接口必须与 teleproto 的 `Logger` 完全一致，
 * 任何遗漏方法都会在构造期或运行期炸掉整条用户账号链路。
 */
const SILENT_MT_PROTO_LOGGER: MtprotoLogger = {
  canSend: () => false,
  error: () => undefined,
  warn: () => undefined,
  info: () => undefined,
  debug: () => undefined,
  log: () => undefined,
  setLevel: () => undefined,
};

export type TelegramUserFailureKind =
  | 'unavailable'
  | 'unsupported'
  | 'auth'
  | 'permission'
  | 'not_found'
  | 'flood'
  | 'network'
  | 'other';

/** 用户账号 MTProto 调用错误（**已脱敏**：绝不携带 session / apiHash / 验证码） */
export class TelegramUserClientError extends Error {
  constructor(
    message: string,
    readonly kind: TelegramUserFailureKind,
    readonly retryAfterSeconds?: number,
  ) {
    super(message);
    this.name = 'TelegramUserClientError';
  }
}

export interface TelegramUserCredentials {
  apiId: number;
  apiHash: string;
  /** StringSession 序列化串；未授权时为空串 */
  session: string;
}

export interface TelegramUserIdentity {
  userId: string;
  username: string | null;
  displayName: string | null;
}

export interface TelegramLoginCodeResult {
  phoneCodeHash: string;
  isCodeViaApp: boolean;
  /**
   * 中间态 StringSession（**尚未授权**，只承载本次生成的 auth key）。
   * 提交验证码时必须复用同一 session，否则 Telegram 会以 PHONE_CODE_EXPIRED 拒绝。
   */
  session: string;
}

export interface TelegramUserAuthorization {
  identity: TelegramUserIdentity;
  /** 授权成功后的 StringSession 串（唯一需要持久化的凭据，由调用方加密保存） */
  session: string;
}

export interface TelegramChatAccess {
  chatId: string;
  title: string | null;
  type: string | null;
  /** 该用户账号是否有权向该 chat 发消息/复制消息 */
  canWrite: boolean;
}

export interface TelegramCopyResult {
  targetChatId: string;
  targetMessageId: string;
}

/** MTProto 模块的最小可用形状（只声明真正使用到的成员） */
interface MtprotoSession {
  save(): string;
}

interface MtprotoMessage {
  id?: number | string;
}

interface MtprotoClient {
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  checkAuthorization(): Promise<boolean>;
  getMe(): Promise<Record<string, unknown>>;
  sendCode(
    apiCredentials: { apiId: number; apiHash: string },
    phoneNumber: string,
    forceSMS?: boolean,
  ): Promise<{ phoneCodeHash?: string; phone_code_hash?: string; isCodeViaApp?: boolean; is_code_via_app?: boolean }>;
  signInWithPassword(
    apiCredentials: { apiId: number; apiHash: string },
    authParams: { password: () => Promise<string>; onError?: (error: Error) => Promise<boolean> | boolean },
  ): Promise<Record<string, unknown>>;
  invoke(request: unknown): Promise<unknown>;
  getEntity(entity: unknown): Promise<Record<string, unknown>>;
  getInputEntity(entity: string | number): Promise<unknown>;
  copyMessages?(entity: unknown, params: Record<string, unknown>): Promise<MtprotoMessage[]>;
  forwardMessages?(entity: unknown, params: Record<string, unknown>): Promise<MtprotoMessage[]>;
  session: MtprotoSession;
}

/**
 * teleproto `Logger` 的真实接口。
 *
 * `baseLogger` 会被 teleproto **直接赋给内部 `this._log`**（构造期即调用 `.info()`，
 * 后续还会用到 `warn/error/debug/setLevel`），因此这里必须逐方法对齐；曾经只传
 * `{ log, warn, error }` 会在 `new TelegramClient()` 内抛
 * `TypeError: this._log.info is not a function`。
 */
interface MtprotoLogger {
  canSend(level: string): boolean;
  error(message: string, error?: unknown): void;
  warn(message: string, error?: unknown): void;
  info(message: string, error?: unknown): void;
  debug(message: string, error?: unknown): void;
  log(level: string, message: string, error?: unknown): void;
  setLevel(level: string): void;
}

interface MtprotoModule {
  TelegramClient: new (
    session: unknown,
    apiId: number,
    apiHash: string,
    options?: Record<string, unknown>,
  ) => MtprotoClient;
  sessions: { StringSession: new (session?: string) => MtprotoSession };
  Api: Record<string, any>;
  /** teleproto@1.229.0 从主入口导出（实测），用于构造完全静默的 baseLogger */
  Logger?: new (level?: string) => MtprotoLogger;
}

/**
 * Telegram 用户账号 MTProto 客户端适配层（阶段 0 冻结：`teleproto@1.229.0`）。
 *
 * 选型依据（已实测）：teleproto 是 gramjs 的活跃维护分支（gramjs 已归档），
 * 纯 JS 实现、**无原生编译依赖**、CJS 主入口（`index.js`）并自带 `index.d.ts`，
 * 与 NestJS/ts-jest 的 CJS 运行时兼容；`npm audit --audit-level=high` 无高危。
 *
 * 为什么用**惰性 require** 而不是顶层 import：依赖缺失或版本不兼容时，静态 import
 * 会让整个后端启动失败；而账号池与镜像默认关闭，用户账号能力属于可选增强。
 * 因此这里以可控方式加载，加载失败时：
 * - `isAvailable()` 返回 false 并给出可诊断原因；
 * - 所有用户账号操作抛 `unavailable` 错误（**fail-closed，绝不伪装可用**）。
 */
@Injectable()
export class TelegramUserClientService {
  private readonly logger = new Logger(TelegramUserClientService.name);
  private readonly timeoutMs: number;
  private loaded: MtprotoModule | null = null;
  private loadFailure: string | null = null;
  private attemptedLoad = false;

  constructor(private readonly configService: ConfigService) {
    const raw = Number(this.configService.get<string>('TELEGRAM_USER_CLIENT_TIMEOUT_MS'));
    this.timeoutMs = Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_TIMEOUT_MS;
  }

  /** 是否可加载 MTProto 客户端模块（不代表已有可用 session） */
  isAvailable(): boolean {
    return this.tryLoad() !== null;
  }

  /** 不可用原因（脱敏，供后台展示） */
  unavailableReason(): string | null {
    return this.tryLoad() === null ? this.loadFailure : null;
  }

  /**
   * 探测一个 session 的授权状态与身份。
   * session 为空时返回 `authorized: false`（尚未登录），不视为错误。
   */
  async inspect(credentials: TelegramUserCredentials): Promise<{
    authorized: boolean;
    identity: TelegramUserIdentity | null;
  }> {
    if (!credentials.session) return { authorized: false, identity: null };
    return this.withClient(credentials, async (client) => {
      const authorized = await client.checkAuthorization();
      if (!authorized) return { authorized: false, identity: null };
      const me = await client.getMe();
      return { authorized: true, identity: this.toIdentity(me) };
    });
  }

  /** 发送登录验证码（验证码由用户在其 Telegram 客户端收到，服务端不接触明文验证码） */
  async sendLoginCode(
    credentials: TelegramUserCredentials,
    phoneNumber: string,
    forceSMS = false,
  ): Promise<TelegramLoginCodeResult> {
    return this.withClient(credentials, async (client) => {
      const result = await client.sendCode(
        { apiId: credentials.apiId, apiHash: credentials.apiHash },
        phoneNumber,
        forceSMS,
      );
      const phoneCodeHash = result?.phoneCodeHash ?? result?.phone_code_hash ?? '';
      if (!phoneCodeHash) {
        throw new TelegramUserClientError('sendCode 未返回 phoneCodeHash', 'other');
      }
      return {
        phoneCodeHash,
        isCodeViaApp: result?.isCodeViaApp ?? result?.is_code_via_app ?? false,
        session: client.session.save(),
      };
    });
  }

  /**
   * 提交验证码（如需 2FA 密码则一并提交）。
   *
   * 注意：验证码与 2FA 密码只在本次调用的内存中存在，**不入库、不入日志**；
   * 成功后只把 StringSession 交给调用方加密保存。
   */
  async signIn(params: {
    credentials: TelegramUserCredentials;
    phoneNumber: string;
    phoneCodeHash: string;
    code: string;
    password?: string;
  }): Promise<TelegramUserAuthorization> {
    const { credentials, phoneNumber, phoneCodeHash, code, password } = params;
    return this.withClient(credentials, async (client, Api) => {
      let me: Record<string, unknown> | null = null;
      try {
        const result = await client.invoke(new Api.auth.SignIn({
          phoneNumber,
          phoneCodeHash,
          phoneCode: code,
        })) as Record<string, unknown>;
        me = result?.user ? (result.user as Record<string, unknown>) : result;
      } catch (error) {
        if (!this.isPasswordNeeded(error)) throw error;
        if (!password) {
          throw new TelegramUserClientError('该账号已启用两步验证，需要提供 2FA 密码', 'auth');
        }
        const authorized = await client.signInWithPassword(
          { apiId: credentials.apiId, apiHash: credentials.apiHash },
          { password: async () => password, onError: async () => false },
        );
        me = authorized;
      }
      const identity = me ? this.toIdentity(me) : await this.resolveIdentity(client);
      return { identity, session: client.session.save() };
    });
  }

  /** 校验用户账号对指定 chat 的可见性与写入权限（权限探测） */
  async checkChatAccess(
    credentials: TelegramUserCredentials,
    chatId: string,
  ): Promise<TelegramChatAccess> {
    return this.withClient(credentials, async (client, Api) => {
      const entity = await this.resolveChat(client, chatId);
      const title = this.readString(entity, ['title', 'firstName', 'username']);
      const type = this.readString(entity, ['className']) ?? this.describeEntityType(entity, Api);
      const canWrite = this.canWriteToChat(entity, Api);
      return { chatId, title, type, canWrite };
    });
  }

  /**
   * 无源复制：把源群消息复制到备份群。
   *
   * 事实边界（不可含糊）：`copyMessages`/`forwardMessages` 是**服务端复制**，
   * 不重新上传文件字节，但**仍需源 `chat_id + message_id` 可被该用户账号访问**；
   * 用户账号必须同时是源群可读成员与备份群可写成员。
   */
  async copyMessage(params: {
    credentials: TelegramUserCredentials;
    sourceChatId: string;
    sourceMessageId: string;
    targetChatId: string;
  }): Promise<TelegramCopyResult> {
    const { credentials, sourceChatId, sourceMessageId, targetChatId } = params;
    return this.withClient(credentials, async (client) => {
      const sourceEntity = await this.resolveChat(client, sourceChatId);
      const targetEntity = await this.resolveChat(client, targetChatId);
      const messageId = Number(sourceMessageId);
      if (!Number.isSafeInteger(messageId) || messageId <= 0) {
        throw new TelegramUserClientError('源消息 ID 非法', 'not_found');
      }
      const forwardParams = { messages: [messageId], fromPeer: sourceEntity };
      const copy = client.copyMessages?.bind(client);
      const forward = client.forwardMessages?.bind(client);
      let copied: MtprotoMessage[];
      if (copy) {
        copied = await copy(targetEntity, forwardParams);
      } else if (forward) {
        // dropAuthor 只影响署名，不改变「服务端复制、不重传字节」的事实
        copied = await forward(targetEntity, { ...forwardParams, dropAuthor: true });
      } else {
        throw new TelegramUserClientError('当前 MTProto 客户端不支持 copyMessages/forwardMessages', 'unsupported');
      }
      const created = Array.isArray(copied) ? copied[0] : null;
      const newId = created?.id;
      if (newId === undefined || newId === null) {
        throw new TelegramUserClientError('复制后未返回目标消息 ID', 'other');
      }
      return { targetChatId, targetMessageId: String(newId) };
    });
  }

  // ---------------- 内部实现 ----------------

  private async withClient<T>(
    credentials: TelegramUserCredentials,
    fn: (client: MtprotoClient, Api: Record<string, any>) => Promise<T>,
  ): Promise<T> {
    const module = this.tryLoad();
    if (!module) {
      throw new TelegramUserClientError(
        this.loadFailure || 'MTProto 客户端模块不可用',
        'unavailable',
      );
    }
    if (!Number.isSafeInteger(credentials.apiId) || credentials.apiId <= 0 || !credentials.apiHash) {
      throw new TelegramUserClientError('API ID / API Hash 配置无效', 'auth');
    }
    let client: MtprotoClient;
    try {
      const session = new module.sessions.StringSession(credentials.session || '');
      client = new module.TelegramClient(session, credentials.apiId, credentials.apiHash, {
        connectionRetries: 3,
        useWSS: false,
        autoReconnect: false,
        // 不打印任何会话/协议级日志，避免把 MTProto 内部细节写入后端日志
        baseLogger: this.createBaseLogger(module),
      });
    } catch (error) {
      // 构造期异常必须同样归类并落日志：历史上 baseLogger 接口漂移导致构造函数内抛
      // TypeError，原始英文异常直接变成 500 响应体且日志无痕（“界面看得到、日志查不到”）。
      const failure = this.classify(error);
      this.logger.warn(`MTProto 客户端构造失败（${failure.kind}）：${failure.message}`);
      throw failure;
    }
    try {
      await this.withTimeout(client.connect(), 'connect');
      return await fn(client, module.Api);
    } catch (error) {
      throw this.classify(error);
    } finally {
      try {
        await client.disconnect();
      } catch {
        // 断连失败不影响结果
      }
    }
  }

  /**
   * 构造完全静默的 `baseLogger`。
   *
   * 优先复用模块自带的 `Logger` 并压到 `none` 级别——这样能自动跟随 teleproto 后续
   * 为 `_log` 新增的方法，避免再次因接口漂移在构造期崩溃；模块未导出 `Logger` 或
   * 构造失败时回退到接口完整的 no-op 实现，**绝不返回残缺对象**。
   */
  private createBaseLogger(module: MtprotoModule): MtprotoLogger {
    const LoggerCtor = module.Logger;
    if (typeof LoggerCtor === 'function') {
      try {
        return new LoggerCtor(MT_PROTO_LOG_LEVEL_NONE);
      } catch {
        // 忽略：回退到下面的完整 no-op 实现
      }
    }
    return SILENT_MT_PROTO_LOGGER;
  }

  private async resolveChat(
    client: MtprotoClient,
    chatId: string,
  ): Promise<Record<string, unknown>> {
    const numeric = Number(chatId);
    const target: string | number = Number.isSafeInteger(numeric) ? numeric : chatId;
    try {
      return await client.getEntity(target) as Record<string, unknown>;
    } catch (error) {
      if (error instanceof TelegramUserClientError) throw error;
      throw new TelegramUserClientError(
        `用户账号无法访问 chat ${this.maskChatId(chatId)}（未加入该群或 chat 标识错误）`,
        'permission',
      );
    }
  }

  /**
   * 静态判定用户账号对 chat 的写入权限。
   *
   * 说明：这是**保守的静态判定**——只在能确定「明确无权」时返回 false（已退出频道、
   * 被禁言 sendMessages、频道默认禁言）；无法判定时返回 true，真正的权限不足会在
   * `copyMessage` 时以 `permission` 分类暴露，由任务层标记 blocked，不做乐观伪造。
   */
  private canWriteToChat(entity: Record<string, unknown>, Api: Record<string, any>): boolean {
    if (entity?.className === 'Channel' && entity?.left === true) return false;
    const bannedRights = entity?.bannedRights as Record<string, unknown> | undefined;
    if (bannedRights?.sendMessages === true) return false;
    if (entity instanceof Api.Channel) {
      const defaultBanned = entity?.defaultBannedRights as Record<string, unknown> | undefined;
      if (defaultBanned?.sendMessages === true) return false;
    }
    return true;
  }

  private async resolveIdentity(client: MtprotoClient): Promise<TelegramUserIdentity> {
    const me = await client.getMe();
    return this.toIdentity(me);
  }

  private toIdentity(me: Record<string, unknown>): TelegramUserIdentity {
    const user = (me?.user as Record<string, unknown>) ?? me;
    const id = user?.id ?? user?.userId;
    return {
      userId: id === undefined || id === null ? '' : String(id),
      username: this.readString(user, ['username']),
      displayName: this.readString(user, ['firstName', 'first_name'])
        ?? this.readString(user, ['title']),
    };
  }

  private describeEntityType(entity: Record<string, unknown>, Api: Record<string, any>): string | null {
    if (entity instanceof Api.Channel) return 'channel';
    if (entity instanceof Api.Chat) return 'group';
    if (entity instanceof Api.User) return 'user';
    return null;
  }

  private readString(source: Record<string, unknown> | undefined, keys: string[]): string | null {
    if (!source) return null;
    for (const key of keys) {
      const value = source[key];
      if (typeof value === 'string' && value.trim()) return value.trim();
    }
    return null;
  }

  private isPasswordNeeded(error: unknown): boolean {
    const message = error instanceof Error ? error.message : String(error);
    return /SESSION_PASSWORD_NEEDED/i.test(message);
  }

  /** 统一错误归类（脱敏；不泄露 session / apiHash / 验证码） */
  private classify(error: unknown): TelegramUserClientError {
    if (error instanceof TelegramUserClientError) return error;
    const message = error instanceof Error ? error.message : String(error);
    const redacted = this.redact(message);
    if (/FLOOD_WAIT_(\d+)/i.test(redacted)) {
      const seconds = Number(/FLOOD_WAIT_(\d+)/i.exec(redacted)?.[1] ?? 0);
      return new TelegramUserClientError(redacted, 'flood', seconds > 0 ? seconds : undefined);
    }
    if (/PHONE_CODE_INVALID|PHONE_CODE_EXPIRED|PHONE_NUMBER_INVALID|SESSION_REVOKED|SESSION_EXPIRED|AUTH_KEY_UNREGISTERED|PASSWORD_HASH_INVALID|SESSION_PASSWORD_NEEDED/i.test(redacted)) {
      return new TelegramUserClientError(redacted, 'auth');
    }
    if (/CHAT_WRITE_FORBIDDEN|CHAT_ADMIN_REQUIRED|USER_BANNED_IN_CHANNEL|CHANNEL_PRIVATE|PEER_ID_INVALID|MESSAGE_ID_INVALID/i.test(redacted)) {
      return new TelegramUserClientError(redacted, 'permission');
    }
    if (/MSG_ID_INVALID|MESSAGE_NOT_FOUND|MESSAGE_DELETE_FORBIDDEN/i.test(redacted)) {
      return new TelegramUserClientError(redacted, 'not_found');
    }
    if (/ETIMEDOUT|ECONNRESET|ECONNREFUSED|EAI_AGAIN|socket hang up|TIMEOUT/i.test(redacted)) {
      return new TelegramUserClientError(redacted, 'network');
    }
    return new TelegramUserClientError(redacted, 'other');
  }

  private redact(text: string): string {
    return text
      .replace(/\b[0-9a-f]{32,}\b/gi, '[REDACTED]')
      .slice(0, 500);
  }

  private maskChatId(chatId: string): string {
    const trimmed = chatId.trim();
    if (trimmed.length <= 4) return '***';
    return `***${trimmed.slice(-4)}`;
  }

  private async withTimeout<T>(promise: Promise<T>, label: string): Promise<T> {
    let timer: NodeJS.Timeout | null = null;
    try {
      return await Promise.race([
        promise,
        new Promise<T>((_, reject) => {
          timer = setTimeout(
            () => reject(new TelegramUserClientError(`MTProto ${label} 超时`, 'network')),
            this.timeoutMs,
          );
          timer.unref?.();
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /** 惰性加载 MTProto 模块；失败原因只记录一次，避免日志刷屏 */
  private tryLoad(): MtprotoModule | null {
    if (this.loaded) return this.loaded;
    if (this.attemptedLoad) return null;
    this.attemptedLoad = true;
    for (const moduleId of CLIENT_MODULE_CANDIDATES) {
      try {
        // 惰性 require：依赖缺失时不让后端启动失败（能力 fail-closed，而非进程退出）
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const loaded = require(moduleId) as MtprotoModule;
        if (loaded?.TelegramClient && loaded?.sessions?.StringSession && loaded?.Api) {
          this.loaded = loaded;
          this.logger.log(`MTProto 客户端已就绪：${moduleId}`);
          return this.loaded;
        }
        this.loadFailure = `MTProto 模块 ${moduleId} 缺少 TelegramClient/StringSession/Api 导出`;
      } catch (error) {
        this.loadFailure = `MTProto 模块 ${moduleId} 加载失败：${error instanceof Error ? error.message : String(error)}`;
      }
    }
    this.logger.warn(`${this.loadFailure}——用户账号能力将保持不可用（fail-closed）`);
    return null;
  }
}
