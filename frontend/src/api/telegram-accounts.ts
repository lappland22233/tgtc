import api from './client';

/**
 * Telegram 账号池与镜像备份管理端点（仅 SUPER_ADMIN，JWT Cookie）。
 *
 * 安全约定（与后端 `telegram-accounts.controller.ts` / `telegram-mirror.controller.ts` 对齐）：
 * - 后端所有响应都是**脱敏视图**，不含 Token / session / API Hash / 完整手机号；
 * - 前端只做透传：`token` / `apiHash` / 验证码 / 2FA 密码只在调用处短暂持有，
 *   **禁止写入 Pinia 持久化、localStorage 或控制台日志**。
 */

// ============================================================
// 账号池
// ============================================================

export type TelegramAccountType = 'bot' | 'user';

export type TelegramAccountStatus =
  | 'pending_auth'
  | 'active'
  | 'disabled'
  | 'degraded'
  | 'revoked'
  | 'draining';

/** 经测试确认的能力快照（只保存布尔结论） */
export interface TelegramAccountCapabilities {
  canUpload?: boolean;
  canReadSource?: boolean;
  canWriteMirror?: boolean;
  supportsPolling?: boolean;
}

/**
 * 账号池运行态视图（进程内画像的脱敏投影）。
 * 只含计数、带宽、健康与冷却信息，**不含任何凭据**。
 */
export interface TelegramAccountRuntimeView {
  inflight: number;
  maxInflight: number;
  bandwidthMbps: number;
  successRate: number;
  latencyMs: number;
  coolingDown: boolean;
  cooldownRemainingMs: number;
  consecutiveFailures: number;
  totalRequests: number;
  failures: number;
  lastErrorKind: string | null;
  /** 是否配置了存储 Chat（false 时该账号只参与下载回源，不会被选为上传/镜像目标） */
  storageConfigured: boolean;
}

/**
 * 环境变量账号只读视图（主 Bot 与 `TELEGRAM_ACCOUNT_POOL` 配置项）。
 *
 * 后台只读：密钥轮换只能改 `.env`，**不提供编辑/删除/轮换**。
 * 视图永不含完整 Token，只给出已脱敏的 `tokenPreview`（如 `123456:AAF***`）。
 */
export interface TelegramEnvAccountView {
  id: string;
  /** 是否为环境变量主 Bot（`TELEGRAM_BOT_TOKEN`） */
  primary: boolean;
  source: 'env';
  /** 恒为 true：后台不提供编辑/删除/轮换 */
  readOnly: true;
  tokenPreview: string;
  chatId: string | null;
  enabled: boolean;
  weight: number;
  maxInflight: number;
  note: string | null;
  runtime: TelegramAccountRuntimeView;
}

/** 账号脱敏视图（`externalId` 形如 `***7890`） */
export interface TelegramAccountView {
  id: string;
  type: TelegramAccountType;
  name: string;
  externalId: string | null;
  status: TelegramAccountStatus;
  enabled: boolean;
  weight: number;
  maxInflight: number;
  primaryChatId: string | null;
  capabilities: TelegramAccountCapabilities | null;
  credentialConfigured: boolean;
  credentialVersion: string | null;
  lastHealthCheckAt: string | null;
  lastSuccessAt: string | null;
  lastFailureAt: string | null;
  lastFailureCode: string | null;
  lastFailureSummary: string | null;
  note: string | null;
  createdAt: string;
  updatedAt: string;
  /** 配置来源：`panel`=仅数据库账号；`both`=同一 Bot 既在数据库又被环境变量注册（密钥以 `.env` 为准） */
  source?: 'panel' | 'both';
  /** 账号池运行态（Bot 账号已在池内注册时有值；用户账号为 null） */
  runtime?: TelegramAccountRuntimeView | null;
}

/** 三层开关的取值来源 */
export type FeatureValueSource = 'runtime' | 'env' | 'forced_disabled' | 'default';

export interface TelegramAccountFeatureState {
  accountPoolEnabled: boolean;
  mirrorEnabled: boolean;
  accountPoolSource: FeatureValueSource;
  mirrorSource: FeatureValueSource;
  /** 紧急止血：env 强制关闭时面板无法开启 */
  accountPoolForceDisabled: boolean;
  mirrorForceDisabled: boolean;
}

/** 前置检查项：`ok=false` 时展示 `hint` */
export interface PrecheckItem {
  id: string;
  ok: boolean;
  hint: string;
}

export interface AccountPoolCounts {
  total: number;
  bot: number;
  user: number;
  enabled: number;
  active: number;
  degraded: number;
  disabled: number;
  revoked: number;
  pendingAuth: number;
}

/**
 * 账号池是否**真正生效**（区分「后台有账号」与「账号池可用」）。
 * `enabled=false` 时 `inactiveReason` 给出可诊断原因。
 */
export interface AccountPoolState {
  enabled: boolean;
  inactiveReason: string | null;
  /** 环境变量主 Bot 的账号 id（未配置 `TELEGRAM_BOT_TOKEN` 时为 null） */
  primaryAccountId: string | null;
  /** 池内注册账号总数（含环境变量与数据库账号） */
  accountCount: number;
  /** 其中来自环境变量的账号数 */
  envAccountCount: number;
}

export interface AccountPoolOverview {
  feature: TelegramAccountFeatureState;
  credentialCryptoAvailable: boolean;
  userClientAvailable: boolean;
  userClientUnavailableReason: string | null;
  counts: AccountPoolCounts;
  /** 账号池生效状态（新契约） */
  pool: AccountPoolState;
  /** 环境变量账号只读视图（主 Bot 与 `TELEGRAM_ACCOUNT_POOL` 配置项） */
  envAccounts: TelegramEnvAccountView[];
  precheck: PrecheckItem[];
}

export interface TelegramAccountListQuery {
  type?: TelegramAccountType;
  status?: TelegramAccountStatus;
  enabled?: boolean;
  keyword?: string;
  /**
   * 是否一并返回「已撤销」（软删除）账号。默认不传即排除已撤销；
   * 显式筛选 `status='revoked'` 时后端也会自动让位。
   */
  includeRevoked?: boolean;
  page?: number;
  pageSize?: number;
}

export interface CreateBotAccountInput {
  name: string;
  token: string;
  primaryChatId?: string;
  weight?: number;
  maxInflight?: number;
  note?: string;
}

// ============================================================
// 副本扩散资格审计（阶段 2 观测面）
// ============================================================

/** 目标解析视图：配置值、可承载账号数与最终有效目标 */
export interface ReplicationTargetView {
  configured: number;
  configuredSource: 'system' | 'env' | 'default';
  eligibleCount: number;
  effectiveTarget: number;
  /** 降级原因（例如可承载账号数低于配置目标） */
  degradedReason: string | null;
  allowedRange: { min: number; max: number };
}

/** 单个 Bot 账号的副本资格与副本分布（脱敏） */
export interface ReplicationAccountView {
  accountId: string;
  enabled: boolean;
  storageConfigured: boolean;
  coolingDown: boolean;
  cooldownRemainingMs: number;
  consecutiveFailures: number;
  inflight: number;
  maxInflight: number;
  readyCopies: number;
  eligible: boolean;
  /** 不可承载副本的原因（已本地化，可直接展示） */
  reasons: string[];
}

export interface ReplicationCoverageView {
  scannedFiles: number;
  satisfied: number;
  unsatisfied: number;
  truncated: boolean;
  missingSamples: Array<{ ownerId: string; readyAccountCount: number; missing: number }>;
}

/** 容量策略状态（全局权重预算自动扩缩容） */
export interface DownloadCapacityView {
  enabled: boolean;
  currentBudget: number;
  targetBudget: number;
  activeBotCount: number;
  eligibleCount: number;
  activeBotIds: string[];
  suspendedReason: string | null;
  frozenReason: string | null;
  pendingUpCycles: number;
  pendingDownCycles: number;
  lastChange: {
    at: string;
    from: number;
    to: number;
    reason: string;
    activeBotCount: number;
    eligibleCount: number;
  } | null;
}

export interface ReplicationAuditReport {
  generatedAt: string;
  target: ReplicationTargetView;
  poolActive: boolean;
  accounts: ReplicationAccountView[];
  coverage: ReplicationCoverageView;
  capacity: DownloadCapacityView | null;
  notes: string[];
}

/** 副本扩散资格审计报告（只读，不触发扩散） */
export async function fetchReplicationAudit(signal?: AbortSignal): Promise<ReplicationAuditReport> {
  const response = await api.get('/admin/telegram-accounts/replication-audit', { signal });
  return response.data.data as ReplicationAuditReport;
}

/** 期望副本数热更新（1-8；有效目标会按可承载账号数收敛） */
export async function updateReplicationTarget(
  desiredReplicas: number,
): Promise<{ message: string; target: ReplicationTargetView }> {
  const response = await api.put('/admin/telegram-accounts/replication-target', { desiredReplicas });
  return response.data.data as { message: string; target: ReplicationTargetView };
}

export interface CreateUserAccountInput {
  name: string;
  apiId: number;
  apiHash: string;
  phoneNumber?: string;
  note?: string;
}

export interface UpdateTelegramAccountInput {
  name?: string;
  enabled?: boolean;
  weight?: number;
  maxInflight?: number;
  primaryChatId?: string;
  note?: string;
}

/** 统一轮换入口（按账号类型解释字段） */
export interface RotateAccountCredentialInput {
  token?: string;
  apiId?: number;
  apiHash?: string;
  phoneNumber?: string;
  primaryChatId?: string;
}

export interface StartUserAuthInput {
  phoneNumber?: string;
  forceSMS?: boolean;
}

export interface StartUserAuthResult {
  phoneMasked: string | null;
  isCodeViaApp: boolean;
  expiresAt: string;
}

export interface VerifyUserAuthInput {
  code: string;
  password?: string;
}

export interface VerifyUserAuthResult {
  ok: boolean;
  status: string;
}

/** 账号池总览：三层开关状态、账号计数、能力前置检查结果 */
export async function fetchAccountOverview(signal?: AbortSignal): Promise<AccountPoolOverview> {
  const response = await api.get('/admin/telegram-accounts/overview', { signal });
  return response.data.data as AccountPoolOverview;
}

/** 账号池总开关（关闭只阻止新任务，不中断在途流量） */
export async function setAccountPoolEnabled(enabled: boolean): Promise<{ message: string; feature: TelegramAccountFeatureState }> {
  const response = await api.put('/admin/telegram-accounts/feature', { enabled });
  return response.data.data as { message: string; feature: TelegramAccountFeatureState };
}

/** 账号列表（分页 + 类型/状态/启用/关键字筛选） */
export async function fetchAccounts(
  query: TelegramAccountListQuery = {},
  signal?: AbortSignal,
): Promise<{ items: TelegramAccountView[]; total: number; envAccounts: TelegramEnvAccountView[] }> {
  const response = await api.get('/admin/telegram-accounts', { params: query, signal });
  const data = response.data.data as
    | { items?: TelegramAccountView[]; total?: number; envAccounts?: TelegramEnvAccountView[] }
    | undefined;
  return {
    items: data?.items ?? [],
    total: Number(data?.total ?? 0),
    // 环境变量账号只读视图：Bot 页签独立只读区展示（用户页签后端恒为空数组）
    envAccounts: data?.envAccounts ?? [],
  };
}

/** 添加 Bot 账号（创建即 getMe + 主存储 Chat 校验，失败不落库） */
export async function createBotAccount(input: CreateBotAccountInput): Promise<{ message: string; account: TelegramAccountView }> {
  const response = await api.post('/admin/telegram-accounts/bots', input);
  return response.data.data as { message: string; account: TelegramAccountView };
}

/** 创建用户账号（进入待授权状态，不参与任何任务） */
export async function createUserAccount(input: CreateUserAccountInput): Promise<{ message: string; account: TelegramAccountView }> {
  const response = await api.post('/admin/telegram-accounts/users', input);
  return response.data.data as { message: string; account: TelegramAccountView };
}

export async function fetchAccount(id: string, signal?: AbortSignal): Promise<TelegramAccountView> {
  const response = await api.get(`/admin/telegram-accounts/${id}`, { signal });
  return response.data.data as TelegramAccountView;
}

/** 更新账号（启停、备注、权重、并发、主存储 Chat） */
export async function updateAccount(
  id: string,
  input: UpdateTelegramAccountInput,
): Promise<{ message: string; account: TelegramAccountView }> {
  const response = await api.patch(`/admin/telegram-accounts/${id}`, input);
  return response.data.data as { message: string; account: TelegramAccountView };
}

/** 删除账号 = 撤销参与资格（软删除，不删除 Telegram 远端备份） */
export async function deleteAccount(id: string): Promise<{ message: string; account: TelegramAccountView }> {
  const response = await api.delete(`/admin/telegram-accounts/${id}`);
  return response.data.data as { message: string; account: TelegramAccountView };
}

/** 测试连接与权限（结论写入能力快照与健康字段） */
export async function testAccount(id: string): Promise<{ message: string; account: TelegramAccountView }> {
  const response = await api.post(`/admin/telegram-accounts/${id}/test`);
  return response.data.data as { message: string; account: TelegramAccountView };
}

/** 环境变量账号探测结论（脱敏；不含 Token） */
export interface EnvAccountProbeResult {
  ok: boolean;
  message: string;
  capabilities: TelegramAccountCapabilities | null;
  chatTitle: string | null;
  chatType: string | null;
  errorCode: string | null;
}

/**
 * 重新探测**环境变量账号**（主 Bot 或 `TELEGRAM_ACCOUNT_POOL` 配置项）。
 *
 * 只读账号不提供编辑/删除/轮换，但必须能验证配置是否仍然有效。
 * 后端仅超级管理员可调用；未注册的账号 id → 404，数据库账号 id → 400。
 */
export async function probeEnvAccount(
  accountId: string,
): Promise<{ message: string; probe: EnvAccountProbeResult }> {
  const response = await api.post(`/admin/telegram-accounts/env/${accountId}/probe`);
  return response.data.data as { message: string; probe: EnvAccountProbeResult };
}

/** 轮换凭据（Bot：新 Token；用户账号：重启授权流程） */
export async function rotateAccount(
  id: string,
  input: RotateAccountCredentialInput,
): Promise<{ message: string; account: TelegramAccountView }> {
  const response = await api.post(`/admin/telegram-accounts/${id}/rotate`, input);
  return response.data.data as { message: string; account: TelegramAccountView };
}

/** 用户账号授权：发送验证码 */
export async function startUserAuth(id: string, input: StartUserAuthInput = {}): Promise<StartUserAuthResult> {
  const response = await api.post(`/admin/telegram-accounts/${id}/auth/start`, input);
  return response.data.data as StartUserAuthResult;
}

/** 用户账号授权：提交验证码（与可选 2FA 密码） */
export async function verifyUserAuth(id: string, input: VerifyUserAuthInput): Promise<VerifyUserAuthResult> {
  const response = await api.post(`/admin/telegram-accounts/${id}/auth/verify`, input);
  return response.data.data as VerifyUserAuthResult;
}

/** 用户账号授权：取消当前授权会话 */
export async function cancelUserAuth(id: string): Promise<{ ok: boolean }> {
  const response = await api.post(`/admin/telegram-accounts/${id}/auth/cancel`);
  return response.data.data as { ok: boolean };
}

// ============================================================
// 镜像备份
// ============================================================

export type TelegramMirrorMode = 'bot_upload' | 'user_copy' | 'auto';
export type TelegramMirrorFallbackMode = 'disabled' | 'bot_upload';
export type TelegramMirrorTestStatus = 'untested' | 'ok' | 'failed';

export type TelegramMirrorTaskStatus =
  | 'queued'
  | 'running'
  | 'succeeded'
  | 'retrying'
  | 'failed'
  | 'blocked'
  | 'cancelled';

export interface MirrorRule {
  id: string;
  enabled: boolean;
  name: string;
  sourceChatId: string;
  targetChatId: string;
  mode: TelegramMirrorMode;
  preferredAccountId: string | null;
  fallbackMode: TelegramMirrorFallbackMode;
  includeWebUploads: boolean;
  includeBotInboundFiles: boolean;
  lastTestedAt: string | null;
  lastTestStatus: TelegramMirrorTestStatus;
  lastTestSummary: string | null;
  createdBy: string | null;
  updatedBy: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface MirrorTaskSummary {
  queued: number;
  running: number;
  succeeded: number;
  retrying: number;
  failed: number;
  blocked: number;
  cancelled: number;
  todaySucceeded: number;
  todayFailed: number;
  todayBlocked: number;
  lastError: { code: string | null; summary: string | null; at: string | null } | null;
}

export interface MirrorTaskListItem {
  id: string;
  ruleId: string;
  ownerType: string;
  ownerId: string;
  sourceVersion: number;
  mode: string;
  status: TelegramMirrorTaskStatus;
  attempts: number;
  sourceAccountId: string | null;
  targetAccountId: string | null;
  targetChatId: string | null;
  targetMessageId: string | null;
  fileName: string | null;
  lastErrorCode: string | null;
  lastErrorSummary: string | null;
  nextRetryAt: string | null;
  startedAt: string | null;
  completedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

/** 镜像运行指标（进程内计数，单实例语义） */
export interface MirrorMetricsSnapshot {
  tasksQueued: number;
  tasksSucceeded: number;
  tasksFailed: number;
  tasksBlocked: number;
  tasksRetried: number;
  botUploadBytes: number;
  botUploadCount: number;
  userCopyCount: number;
  fallbackCount: number;
}

export interface MirrorFeatureState {
  mirrorEnabled: boolean;
  source: FeatureValueSource;
  forceDisabled: boolean;
}

export interface MirrorRuleTestDetail {
  chat: 'source' | 'target';
  ok: boolean;
  title: string | null;
  type: string | null;
  error?: string;
}

export interface MirrorRuleTestResult {
  status: TelegramMirrorTestStatus;
  summary: string;
  details: MirrorRuleTestDetail[];
}

export interface MirrorOverview {
  rule: MirrorRule | null;
  test: { status: TelegramMirrorTestStatus; summary: string | null; testedAt: string | null } | null;
  tasks: MirrorTaskSummary;
  metrics: MirrorMetricsSnapshot;
  feature: MirrorFeatureState;
  precheck: PrecheckItem[];
  notes: string[];
}

export interface UpdateMirrorRuleInput {
  name?: string;
  sourceChatId?: string;
  targetChatId?: string;
  mode?: TelegramMirrorMode;
  preferredAccountId?: string;
  fallbackMode?: TelegramMirrorFallbackMode;
  includeWebUploads?: boolean;
  includeBotInboundFiles?: boolean;
}

export interface MirrorTaskListQuery {
  status?: TelegramMirrorTaskStatus;
  mode?: TelegramMirrorMode;
  /** 归属对象 ID（站内文件 ID） */
  ownerId?: string;
  accountId?: string;
  page?: number;
  pageSize?: number;
}

/** 镜像配置总览：规则、测试结论、任务概览、指标与前置检查 */
export async function fetchMirrorOverview(signal?: AbortSignal): Promise<MirrorOverview> {
  const response = await api.get('/admin/telegram-mirror', { signal });
  return response.data.data as MirrorOverview;
}

/** 更新规则（源群、备份群、模式、账号偏好、事件范围） */
export async function updateMirrorRule(input: UpdateMirrorRuleInput): Promise<{ message: string; rule: MirrorRule }> {
  const response = await api.put('/admin/telegram-mirror', input);
  return response.data.data as { message: string; rule: MirrorRule };
}

/** 镜像功能总开关（关闭只阻止新任务） */
export async function setMirrorEnabled(enabled: boolean): Promise<{ message: string }> {
  const response = await api.put('/admin/telegram-mirror/feature', { enabled });
  return response.data.data as { message: string };
}

/** 启用/停用规则（启用前必须通过权限测试） */
export async function setMirrorRuleEnabled(enabled: boolean): Promise<{ message: string; rule: MirrorRule }> {
  const response = await api.put('/admin/telegram-mirror/rule/enabled', { enabled });
  return response.data.data as { message: string; rule: MirrorRule };
}

/** 权限测试（发送/复制一条受控测试并不产生真实镜像任务） */
export async function testMirrorRule(): Promise<MirrorRuleTestResult> {
  const response = await api.post('/admin/telegram-mirror/test');
  return response.data.data as MirrorRuleTestResult;
}

/** 任务列表（按状态/模式/文件/账号筛选） */
export async function fetchMirrorTasks(
  query: MirrorTaskListQuery = {},
  signal?: AbortSignal,
): Promise<{ items: MirrorTaskListItem[]; total: number }> {
  const response = await api.get('/admin/telegram-mirror/tasks', { params: query, signal });
  const data = response.data.data as { items?: MirrorTaskListItem[]; total?: number } | undefined;
  return { items: data?.items ?? [], total: Number(data?.total ?? 0) };
}

/** 手动重试失败/阻塞/取消的任务 */
export async function retryMirrorTask(id: string): Promise<{ message: string; task: MirrorTaskListItem }> {
  const response = await api.post(`/admin/telegram-mirror/tasks/${id}/retry`);
  return response.data.data as { message: string; task: MirrorTaskListItem };
}

/** 取消尚未开始的任务（执行中的任务不允许中断） */
export async function cancelMirrorTask(id: string): Promise<{ message: string; task: MirrorTaskListItem }> {
  const response = await api.post(`/admin/telegram-mirror/tasks/${id}/cancel`);
  return response.data.data as { message: string; task: MirrorTaskListItem };
}

/** 历史补偿任务状态（后端为单实例进程内状态） */
export type MirrorBackfillStatus = 'idle' | 'running' | 'paused' | 'completed' | 'cancelled' | 'failed';

export interface MirrorBackfillJob {
  status: MirrorBackfillStatus;
  mode: 'dry-run' | 'apply';
  limit: number;
  scanned: number;
  queued: number;
  skipped: number;
  /** dry-run 模式下将入队的样本文件 ID（最多 20 个），用于评估影响面 */
  sample: string[];
  startedAt: string | null;
  updatedAt: string;
  finishedAt: string | null;
  lastError: string | null;
  cursor: string | null;
}

/** 历史补偿状态 */
export async function fetchMirrorBackfill(signal?: AbortSignal): Promise<MirrorBackfillJob> {
  const response = await api.get('/admin/telegram-mirror/backfill', { signal });
  return (response.data.data as { job: MirrorBackfillJob }).job;
}

/** 启动历史补偿（dry-run 只统计不入队；apply 按批限速入队） */
export async function startMirrorBackfill(
  input: { mode: 'dry-run' | 'apply'; limit?: number },
): Promise<{ message: string; job: MirrorBackfillJob }> {
  const response = await api.post('/admin/telegram-mirror/backfill', input);
  return response.data.data as { message: string; job: MirrorBackfillJob };
}

export async function pauseMirrorBackfill(): Promise<{ message: string; job: MirrorBackfillJob }> {
  const response = await api.post('/admin/telegram-mirror/backfill/pause');
  return response.data.data as { message: string; job: MirrorBackfillJob };
}

export async function resumeMirrorBackfill(): Promise<{ message: string; job: MirrorBackfillJob }> {
  const response = await api.post('/admin/telegram-mirror/backfill/resume');
  return response.data.data as { message: string; job: MirrorBackfillJob };
}

export async function cancelMirrorBackfill(): Promise<{ message: string; job: MirrorBackfillJob }> {
  const response = await api.post('/admin/telegram-mirror/backfill/cancel');
  return response.data.data as { message: string; job: MirrorBackfillJob };
}
