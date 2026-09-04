/**
 * 系统更新链路的前端契约（与后端 update 模块 DTO/响应严格对齐）。
 * 仅含后端实际返回的字段；内部路径、Token 等敏感信息后端一律不下发。
 */

export type UpdateTaskStatus =
  | 'queued' | 'downloading' | 'verifying' | 'prechecking' | 'backing_up'
  | 'extracting' | 'migrating' | 'activating' | 'restarting' | 'health_checking'
  | 'succeeded'
  | 'rollback_pending' | 'rolling_back' | 'rolled_back' | 'rollback_failed'
  | 'cancelled';

export type UpdateCheckStatus = 'disabled' | 'error' | 'up_to_date' | 'update_available' | 'stale';

export interface ReleaseManifest {
  schemaVersion: 1;
  version: string;
  channel: 'stable';
  publishedAt: string;
  platform: 'linux';
  arch: 'x64';
  asset: { name: string; size: number; sha256: string };
  minUpgradableVersion: string;
  maxUpgradableVersion: string | null;
  includesDbMigration: boolean;
  programRollbackSafe: boolean;
  healthCheck: { path: string; timeoutMs: number };
}

export interface UpdateCandidate {
  releaseId: number;
  releaseTag: string;
  version: string;
  channel: 'stable';
  publishedAt: string;
  /** 发行说明原文（纯文本渲染，必须 pre-wrap，禁止按 HTML/Markdown 注入渲染） */
  releaseNotes: string;
  asset: { name: string; size: number; sha256: string };
  manifest: ReleaseManifest;
  /** 当前版本是否允许自动升级；false 时安装按钮必须禁用 */
  compatible: boolean;
  compatibilityReason: 'below_min_upgradable' | 'above_max_upgradable' | 'rollback_unsafe' | null;
}

export interface UpdateCheckResult {
  status: UpdateCheckStatus;
  /** true：本次未取得新结果，展示最后一次成功快照 */
  stale: boolean;
  currentVersion: string;
  checkedAt: string;
  lastSuccessfulCheckAt: string | null;
  reason: string | null;
  reasonText: string | null;
  candidate: UpdateCandidate | null;
  latestStableVersion: string | null;
}

export interface UpdateTaskSummary {
  taskId: string;
  currentVersion: string;
  targetVersion: string;
  releaseId: number;
  releaseTag: string;
  status: UpdateTaskStatus;
  progress: number;
  errorCode: string | null;
  errorSummary: string | null;
  rollbackStatus: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  requestedBy: string;
  metadata: Record<string, unknown> | null;
}

export interface UpdateStatusResponse extends UpdateCheckResult {
  checkEnabled: boolean;
  installEnabled: boolean;
  activeTask: UpdateTaskSummary | null;
}

/** 状态机正向阶段（用于进度展示顺序） */
export const UPDATE_FORWARD_STAGES: readonly UpdateTaskStatus[] = [
  'queued', 'downloading', 'verifying', 'prechecking', 'backing_up',
  'extracting', 'migrating', 'activating', 'restarting', 'health_checking', 'succeeded',
];

export const UPDATE_STAGE_LABELS: Record<UpdateTaskStatus, string> = {
  queued: '排队中',
  downloading: '下载发行包',
  verifying: '可信校验',
  prechecking: '环境预检',
  backing_up: '数据库备份',
  extracting: '解包新版本',
  migrating: '数据库迁移',
  activating: '原子切换',
  restarting: '重启服务',
  health_checking: '健康检查',
  succeeded: '升级成功',
  rollback_pending: '等待回退',
  rolling_back: '正在回退',
  rolled_back: '已回退旧版本',
  rollback_failed: '回退失败',
  cancelled: '已取消',
};

export const UPDATE_FAILURE_REASON_TEXT: Record<string, string> = {
  timeout: '更新源请求超时',
  network: '更新源不可达',
  rate_limited: '更新源限流，请稍后重试',
  forbidden: '更新源拒绝访问',
  not_found: '更新源仓库不可用',
  http_5xx: '更新源服务异常',
  http_4xx: '更新源请求被拒绝',
  malformed: '更新源响应格式非法',
  current_version_unknown: '无法确定当前运行版本',
  public_key_missing: '缺少发布签名验证公钥',
  release_incomplete: '候选 Release 资产不完整',
  release_mismatch: '候选 Release 可信核验未通过',
};

export const UPDATE_COMPATIBILITY_TEXT: Record<string, string> = {
  below_min_upgradable: '当前版本低于该版本允许的最低升级起点，需按运维文档人工升级',
  above_max_upgradable: '当前版本高于该版本允许的最高自动升级范围',
  rollback_unsafe: '该版本不支持安全的程序回退，已阻止自动安装',
};
