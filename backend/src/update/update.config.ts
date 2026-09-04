import { resolve } from 'path';

/** 更新配置只读注入令牌（启动时加载并校验一次，模块内共享） */
export const UPDATE_CONFIG = Symbol('UPDATE_CONFIG');

/**
 * 更新链路配置。安全根参数（仓库、公钥、更新器入口）只允许通过环境变量或
 * 只读部署配置设置，绝不通过系统配置 API 暴露或修改。
 *
 * 启动时由 loadUpdateConfig 校验：非法值直接抛错让 AppModule 启动失败，
 * 避免带着不可信配置进入运行期。路径必须为绝对路径且不允许穿越。
 */
export interface UpdateConfig {
  /** 是否允许版本检查（关闭后 update 模块整体只读） */
  checkEnabled: boolean;
  /** 是否允许触发安装（首次上线 false，演练通过后开启） */
  installEnabled: boolean;
  /** 固定可信更新源；不接受运行期修改 */
  githubOwner: string;
  githubRepo: string;
  channel: 'stable';
  /** 可选 GitHub Token；仅从环境变量读取，全程脱敏，绝不入库或返回前端 */
  githubToken: string | null;
  /** GitHub API 请求超时（毫秒） */
  checkTimeoutMs: number;
  /** 成功检查结果的内存缓存 TTL（毫秒） */
  cacheTtlMs: number;
  /** 两次真实外呼检查的最小间隔（毫秒），限流保护 */
  minCheckIntervalMs: number;
  /** 发行 ZIP 大小上限（字节） */
  maxAssetBytes: number;
  /** 清单/SHA256SUMS 等小制品的大小上限（字节） */
  maxMetadataBytes: number;
  /** 发布签名验证公钥路径（默认指向仓库/发行包内置公钥） */
  publicKeyPath: string;
  /** 固定下载暂存目录（阶段 4 执行器使用；必须为绝对路径） */
  stagingDir: string | null;
  /** 固定任务描述目录（UpdateRunnerService 写入任务 JSON；必须为绝对路径） */
  taskDir: string | null;
  /** 固定更新器入口（阶段 4 执行器使用；必须为绝对路径） */
  updaterPath: string | null;
  /** 整体更新任务超时（毫秒） */
  taskTimeoutMs: number;
  /** 激活后健康检查超时（毫秒） */
  healthTimeoutMs: number;
}

const OWNER_REPO_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;

function readPositiveInt(env: NodeJS.ProcessEnv, key: string, fallback: number, min: number, max: number): number {
  const raw = env[key];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new Error(`UPDATE 配置 ${key} 必须是 ${min}-${max} 之间的整数，当前为 ${JSON.stringify(raw)}`);
  }
  return value;
}

function readBool(env: NodeJS.ProcessEnv, key: string, fallback: boolean): boolean {
  const raw = env[key];
  if (raw === undefined || raw === '') return fallback;
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  throw new Error(`UPDATE 配置 ${key} 必须是 true/false，当前为 ${JSON.stringify(raw)}`);
}

function readOptionalPath(env: NodeJS.ProcessEnv, key: string): string | null {
  const raw = env[key];
  if (raw === undefined || raw === '') return null;
  const trimmed = raw.trim();
  if (!trimmed.startsWith('/') && !/^[A-Za-z]:[\\/]/.test(trimmed)) {
    throw new Error(`UPDATE 配置 ${key} 必须是绝对路径，当前为 ${JSON.stringify(raw)}`);
  }
  if (trimmed.includes('..')) {
    throw new Error(`UPDATE 配置 ${key} 不允许包含路径穿越片段：${JSON.stringify(raw)}`);
  }
  return trimmed;
}

export function resolveDefaultPublicKeyPath(): string {
  // 发行包布局：backend/dist/update → 上三级为发行根；源码：backend/src/update → 上三级为仓库根。
  return resolve(__dirname, '..', '..', '..', 'scripts', 'release', 'update-public-key.pem');
}

/**
 * 从环境变量加载并校验更新配置；任何非法值抛错（启动失败优先于带病运行）。
 */
export function loadUpdateConfig(env: NodeJS.ProcessEnv = process.env): UpdateConfig {
  const githubOwner = env.UPDATE_GITHUB_OWNER?.trim() || 'lappland22233';
  const githubRepo = env.UPDATE_GITHUB_REPO?.trim() || 'tgtc';
  if (!OWNER_REPO_PATTERN.test(githubOwner) || !OWNER_REPO_PATTERN.test(githubRepo)) {
    throw new Error('UPDATE 配置 UPDATE_GITHUB_OWNER/UPDATE_GITHUB_REPO 含非法字符。');
  }

  const channel = env.UPDATE_CHANNEL?.trim() || 'stable';
  if (channel !== 'stable') {
    throw new Error(`UPDATE 配置 UPDATE_CHANNEL 当前仅支持 stable，收到 ${JSON.stringify(channel)}`);
  }

  const githubToken = env.UPDATE_GITHUB_TOKEN?.trim() || null;

  const stagingDir = readOptionalPath(env, 'UPDATE_STAGING_DIR');
  const taskDir = readOptionalPath(env, 'UPDATE_TASK_DIR');
  const updaterPath = readOptionalPath(env, 'UPDATE_UPDATER_PATH');
  // 显式提供的公钥路径与目录参数使用同一绝对路径校验。
  const publicKeyOverride = readOptionalPath(env, 'UPDATE_PUBLIC_KEY_PATH');

  return {
    checkEnabled: readBool(env, 'UPDATE_CHECK_ENABLED', true),
    installEnabled: readBool(env, 'UPDATE_INSTALL_ENABLED', false),
    githubOwner,
    githubRepo,
    channel: 'stable',
    githubToken,
    checkTimeoutMs: readPositiveInt(env, 'UPDATE_CHECK_TIMEOUT_MS', 10_000, 1_000, 60_000),
    cacheTtlMs: readPositiveInt(env, 'UPDATE_CACHE_TTL_MS', 1_800_000, 30_000, 86_400_000),
    minCheckIntervalMs: readPositiveInt(env, 'UPDATE_MIN_CHECK_INTERVAL_MS', 10_000, 1_000, 3_600_000),
    maxAssetBytes: readPositiveInt(env, 'UPDATE_MAX_ASSET_BYTES', 3 * 1024 * 1024 * 1024, 1024 * 1024, 20 * 1024 * 1024 * 1024),
    maxMetadataBytes: readPositiveInt(env, 'UPDATE_MAX_METADATA_BYTES', 1024 * 1024, 1024, 16 * 1024 * 1024),
    publicKeyPath: publicKeyOverride ?? resolveDefaultPublicKeyPath(),
    stagingDir,
    taskDir,
    updaterPath,
    taskTimeoutMs: readPositiveInt(env, 'UPDATE_TASK_TIMEOUT_MS', 1_800_000, 60_000, 86_400_000),
    healthTimeoutMs: readPositiveInt(env, 'UPDATE_HEALTH_TIMEOUT_MS', 60_000, 5_000, 600_000),
  };
}

/** 更新源与资产下载的唯一允许主机（固定 GitHub，下载前做白名单校验）。 */
export const GITHUB_ALLOWED_ASSET_HOST = 'github.com';
export const GITHUB_API_BASE = 'https://api.github.com';
