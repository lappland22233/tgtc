export interface SiteConfigState {
  title: string;
}

export interface AuthConfigState {
  registrationEnabled: boolean;
  emailVerificationEnabled: boolean;
  turnstileEnabled: boolean;
  siteKey: string;
  secretKey: string;
  hostnames: string;
}

export interface SmtpConfigState {
  host: string;
  port: number;
  secure: boolean;
  user: string;
  password: string;
  from: string;
}

export interface UploadConfigState {
  maxFileSizeMB: number;
  fileTypeMode: 'blacklist' | 'whitelist';
  fileTypeFilter: string;
  accessCountDefault: number;
  accessCountMax: number;
}

export interface CacheConfigState {
  maxSizeGB: number;
  minFreeDiskGB: number;
  ttlDays: number;
  noCacheMode: boolean;
}

export interface DownloadConfigState {
  maxReservedGB: number;
  maxConcurrentUpstreams: number;
  queueCapacity: number;
  queueTimeoutSeconds: number;
  spoolGraceSeconds: number;
  directWindowMB: number;
  directWaitSeconds: number;
  taskRetentionSeconds: number;
  upstreamQueuePolicy: 'strict_fifo' | 'bounded_fit';
  autoCapacityEnabled: boolean;
  preferUserAccount: boolean;
  userStreamMaxConcurrency: number;
  userFailureCooldownSeconds: number;
}

export interface DownloadRuntime {
  freeBytes: number;
  minimumFreeBytes: number;
  reservedRemainingBytes: number;
  cacheReservedBytes: number;
  cacheCommittedBytes: number;
  cacheMaxBytes: number;
  waitingDiskTasks: number;
  waitingUpstreamTasks: number;
  activeUpstreams: number;
  maxConcurrentUpstreams: number;
  oldestDiskWaitMs: number;
  activeReservations: number;
  noCacheMode: boolean;
  runtimeUnavailable?: boolean;
  activeUpstreamWeight?: number;
  oldestUpstreamWaitMs?: number;
  upstreamQueuePolicy?: 'strict_fifo' | 'bounded_fit';
  memory?: {
    rssBytes: number;
    heapUsedBytes: number;
    heapTotalBytes: number;
    externalBytes: number;
    arrayBuffersBytes: number;
  };
  streams?: {
    buildSessions: number;
    spoolSessions: number;
    spoolConsumers: number;
    directStreams: number;
    directWindowBytesTotal: number;
    followerBufferAllocations: number;
  };
}

export interface ReplicaTargetInfo {
  configured: number;
  eligibleCount: number;
  effectiveTarget: number;
}

export interface BotConfigState {
  linkTtlHours: number;
  dailyLimit: number;
  quotaTimezone: string;
  linkDomainMode: 'auto' | 'manual';
  linkDomain: string;
  storageMode: 'telegram' | 'gdrive';
  telegramStorageChatConfigured: boolean;
}

export interface BannedIpRecord {
  id: string;
  ip: string;
  reason: string | null;
  isPermanent: boolean;
  expiresAt: string | null;
  createdAt: string;
}

export interface BanIpFormState {
  ip: string;
  reason: string;
  permanent: boolean;
  durationHours: number;
}

export type PresetExtensionItem = string | { ext: string; danger: boolean };
