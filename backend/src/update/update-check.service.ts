import { Inject, Injectable, Logger } from '@nestjs/common';
import { readFileSync } from 'fs';
import { compareSemver, isStableVersion, versionFromTag } from '../version/semver';
import { VersionService, VERSION_UNKNOWN } from '../version/version.service';
import { ConfigCacheService } from '../common/services/config-cache.service';
import {
  classifyGithubError,
  GithubFailureKind,
  GithubReleaseClient,
  GithubReleaseRaw,
  GITHUB_FAILURE_REASON_TEXT,
} from './github-release.client';
import {
  parseReleaseManifest,
  parseSha256Sums,
  ReleaseManifest,
  sha256Hex,
  verifySha256SumsSignature,
} from './release-manifest';
import { UpdateConfig, UPDATE_CONFIG } from './update.config';

export type UpdateCheckStatus = 'disabled' | 'error' | 'up_to_date' | 'update_available' | 'stale';

export type UpdateFailureReason =
  | 'current_version_unknown'
  | 'public_key_missing'
  | 'release_incomplete'
  | 'release_mismatch'
  | GithubFailureKind;

/** 检查得到的可安装候选；安装时后端会基于 releaseId 再次核验。 */
export interface UpdateCandidate {
  releaseId: number;
  releaseTag: string;
  version: string;
  channel: 'stable';
  publishedAt: string;
  /** 发行说明原文（纯文本渲染；禁止前端按 HTML/Markdown 注入渲染） */
  releaseNotes: string;
  asset: { name: string; size: number; sha256: string };
  /** 执行器所需制品的下载锚点（URL 均来自 GitHub API 响应，经主机白名单校验） */
  downloads: {
    assetUrl: string;
    sumsUrl: string;
    sumsSha256: string;
    sumsSigUrl: string;
    manifestUrl: string;
    manifestSha256: string;
  };
  manifest: ReleaseManifest;
  /** 当前版本是否允许自动升级到该候选 */
  compatible: boolean;
  compatibilityReason: 'below_min_upgradable' | 'above_max_upgradable' | 'rollback_unsafe' | null;
}

export interface UpdateCheckResult {
  status: UpdateCheckStatus;
  /** true：本次未能取得新结果，返回的是最后一次成功快照 */
  stale: boolean;
  currentVersion: string;
  /** 本次尝试时间（无论成败） */
  checkedAt: string;
  /** 最后一次成功核验的时间 */
  lastSuccessfulCheckAt: string | null;
  /** 脱敏失败原因代码（error/stale 时非空） */
  reason: UpdateFailureReason | null;
  reasonText: string | null;
  candidate: UpdateCandidate | null;
  /** 最新稳定版本号（即使已是最新也返回，供前端展示） */
  latestStableVersion: string | null;
}

interface CheckSnapshot {
  schemaVersion: 1;
  checkedAt: string;
  etag: string | null;
  candidate: UpdateCandidate | null;
  latestStableVersion: string | null;
}

const SNAPSHOT_KEY = 'update_check_snapshot';
const SNAPSHOT_SCHEMA_VERSION = 1;

/**
 * 版本检查编排服务。
 *
 * - 只接受固定仓库的稳定 Release（draft/prerelease/预发布 SemVer 一律忽略）。
 * - 候选必须通过完整可信核验：清单严格解析 + SHA256SUMS 签名验证 + 摘要/大小交叉核对。
 * - 成功结果写入内存缓存与 DB 快照（ConfigCacheService），重启后可恢复 last-success。
 * - GitHub 故障时返回最后成功快照并标记 stale，绝不伪装成"已是最新版"。
 * - 单飞去重 + 最小外呼间隔，保护 GitHub API 配额。
 */
@Injectable()
export class UpdateCheckService {
  private readonly logger = new Logger(UpdateCheckService.name);
  private pendingCheck: Promise<UpdateCheckResult> | null = null;
  private lastResult: UpdateCheckResult | null = null;
  private lastCheckStartedAt = 0;
  private snapshot: CheckSnapshot | null = null;
  private snapshotLoaded = false;
  private publicKeyCache: string | null = null;

  constructor(
    private readonly versionService: VersionService,
    private readonly client: GithubReleaseClient,
    @Inject(UPDATE_CONFIG) private readonly config: UpdateConfig,
    private readonly configCacheService: ConfigCacheService,
  ) {}

  /** 当前检查状态（含配置开关），供管理端 status 端点聚合。 */
  async getStatus(): Promise<UpdateCheckResult & { checkEnabled: boolean; installEnabled: boolean }> {
    await this.loadSnapshot();
    const base = this.composeResultFromSnapshot(VERSION_UNKNOWN === this.versionService.getCurrentVersion());
    return {
      ...base,
      checkEnabled: this.config.checkEnabled,
      installEnabled: this.config.installEnabled,
    };
  }

  /**
   * 执行检查。force=false 时受最小外呼间隔约束（直接返回上次结果）；
   * 并发调用共享同一次外呼（单飞）。
   */
  async check(force = true): Promise<UpdateCheckResult> {
    if (!this.config.checkEnabled) {
      return this.composeDisabledResult();
    }
    if (!force && this.lastResult && Date.now() - this.lastCheckStartedAt < this.config.minCheckIntervalMs) {
      return this.lastResult;
    }
    if (this.pendingCheck) return this.pendingCheck;
    this.lastCheckStartedAt = Date.now();
    const promise = this.doCheck()
      .then((result) => {
        this.lastResult = result;
        return result;
      })
      .finally(() => {
        this.pendingCheck = null;
      });
    this.pendingCheck = promise;
    return promise;
  }

  /**
   * 按 releaseId 重新核验候选（安装前调用，防止检查与安装之间候选被替换）。
   * 返回 null 表示该 Release 已不存在；核验失败抛出带脱敏原因的错误。
   */
  async getVerifiedCandidate(releaseId: number, currentVersion: string): Promise<UpdateCandidate> {
    const release = await this.client.fetchReleaseById(releaseId);
    if (!release) {
      throw this.verificationError('release_incomplete', '候选 Release 已不存在');
    }
    return this.verifyReleaseAssets(release, currentVersion);
  }

  private async doCheck(): Promise<UpdateCheckResult> {
    const currentVersion = this.versionService.getCurrentVersion();
    if (currentVersion === VERSION_UNKNOWN) {
      return this.errorResult('current_version_unknown', '无法确定当前运行版本');
    }

    const snapshot = await this.loadSnapshot();
    let response;
    try {
      response = await this.client.fetchReleases(snapshot?.etag ?? null);
    } catch (error) {
      const kind = (error as { updateFailureKind?: GithubFailureKind }).updateFailureKind
        ?? classifyGithubError(error);
      this.logger.warn(`GitHub 版本检查失败：${kind}`);
      return this.staleResult(currentVersion, kind);
    }

    if (response.status === 304) {
      // 更新源确认内容未变化：快照仍然新鲜，刷新检查时间并复算结论。
      const candidate = this.resolveCandidateForCurrent(snapshot, currentVersion);
      const freshSnapshot: CheckSnapshot = {
        schemaVersion: SNAPSHOT_SCHEMA_VERSION,
        checkedAt: new Date().toISOString(),
        etag: snapshot?.etag ?? null,
        candidate,
        latestStableVersion: snapshot?.latestStableVersion ?? candidate?.version ?? null,
      };
      await this.persistSnapshot(freshSnapshot);
      const lastSuccess = freshSnapshot.checkedAt;
      return {
        status: candidate ? 'update_available' : 'up_to_date',
        stale: false,
        currentVersion,
        checkedAt: lastSuccess,
        lastSuccessfulCheckAt: lastSuccess,
        reason: null,
        reasonText: null,
        candidate,
        latestStableVersion: freshSnapshot.latestStableVersion,
      };
    }

    const releases = response.releases ?? [];
    const stableReleases = releases
      .filter((release) => !release.draft && !release.prerelease)
      .map((release) => ({ release, version: versionFromTag(release.tag_name) }))
      .filter((entry): entry is { release: GithubReleaseRaw; version: string } =>
        entry.version !== null && isStableVersion(entry.version))
      .sort((a, b) => {
        const order = compareSemver(b.version, a.version);
        return order ?? 0;
      });

    const latest = stableReleases[0] ?? null;
    const latestStableVersion = latest?.version ?? null;

    if (!latest || (compareSemver(latest.version, currentVersion) ?? 1) <= 0) {
      // 无更新或仅存在降级/同版本候选：按已是最新处理（防降级）。
      const freshSnapshot: CheckSnapshot = {
        schemaVersion: SNAPSHOT_SCHEMA_VERSION,
        checkedAt: new Date().toISOString(),
        etag: response.etag,
        candidate: null,
        latestStableVersion,
      };
      await this.persistSnapshot(freshSnapshot);
      return {
        status: 'up_to_date',
        stale: false,
        currentVersion,
        checkedAt: freshSnapshot.checkedAt,
        lastSuccessfulCheckAt: freshSnapshot.checkedAt,
        reason: null,
        reasonText: null,
        candidate: null,
        latestStableVersion,
      };
    }

    // 有更高稳定版：完整核验清单、摘要与签名后才作为候选呈现。
    try {
      const candidate = await this.verifyReleaseAssets(latest.release, currentVersion);
      const freshSnapshot: CheckSnapshot = {
        schemaVersion: SNAPSHOT_SCHEMA_VERSION,
        checkedAt: new Date().toISOString(),
        etag: response.etag,
        candidate,
        latestStableVersion,
      };
      await this.persistSnapshot(freshSnapshot);
      return {
        status: 'update_available',
        stale: false,
        currentVersion,
        checkedAt: freshSnapshot.checkedAt,
        lastSuccessfulCheckAt: freshSnapshot.checkedAt,
        reason: null,
        reasonText: null,
        candidate,
        latestStableVersion,
      };
    } catch (error) {
      const reason = (error as { updateFailureReason?: UpdateFailureReason }).updateFailureReason
        ?? 'release_mismatch';
      this.logger.warn(`候选 Release 核验失败：${reason}`);
      // 核验失败不视为检查成功：保留旧快照时间戳，标记为 stale 以免误导。
      return this.staleResult(currentVersion, reason);
    }
  }

  /**
   * 对单个 Release 执行完整可信核验并构建候选：
   * 严格资产名匹配 → 下载清单并严格解析 → 下载 SHA256SUMS/签名 → 公钥验签 →
   * 清单摘要/大小与 SHA256SUMS、GitHub 资产元数据交叉核对。
   */
  private async verifyReleaseAssets(release: GithubReleaseRaw, currentVersion: string): Promise<UpdateCandidate> {
    const version = versionFromTag(release.tag_name);
    if (!version || !isStableVersion(version)) {
      throw this.verificationError('release_mismatch', '候选不是合法稳定版');
    }
    const expectedAssetName = `tgtc-v${version}-linux-x64.zip`;
    const byName = (name: string) => release.assets.find((asset) => asset.name === name) ?? null;
    const zipAsset = byName(expectedAssetName);
    const manifestAsset = byName('release-manifest.json');
    const sumsAsset = byName('SHA256SUMS');
    const sigAsset = byName('SHA256SUMS.sig');
    if (!zipAsset || !manifestAsset || !sumsAsset || !sigAsset) {
      throw this.verificationError('release_incomplete', '候选 Release 缺少必需资产');
    }

    const publicKey = this.loadPublicKey();
    let manifestBytes: Buffer;
    let sumsBytes: Buffer;
    let sigBytes: Buffer;
    try {
      [manifestBytes, sumsBytes, sigBytes] = await Promise.all([
        this.client.fetchAssetBytes(manifestAsset.browser_download_url, this.config.maxMetadataBytes),
        this.client.fetchAssetBytes(sumsAsset.browser_download_url, this.config.maxMetadataBytes),
        this.client.fetchAssetBytes(sigAsset.browser_download_url, this.config.maxMetadataBytes),
      ]);
    } catch (error) {
      throw this.verificationError(
        (error as { updateFailureKind?: GithubFailureKind }).updateFailureKind ?? 'network',
        '下载清单或签名失败',
      );
    }

    if (!verifySha256SumsSignature(sumsBytes, sigBytes, publicKey)) {
      throw this.verificationError('release_mismatch', 'SHA256SUMS 签名验证失败');
    }
    const sums = parseSha256Sums(sumsBytes.toString('utf8'));
    if (!sums || !sums.has(expectedAssetName)) {
      throw this.verificationError('release_incomplete', 'SHA256SUMS 缺少发行包摘要');
    }

    let manifestJson: unknown;
    try {
      manifestJson = JSON.parse(manifestBytes.toString('utf8'));
    } catch {
      throw this.verificationError('release_mismatch', '清单不是合法 JSON');
    }
    const parsed = parseReleaseManifest(manifestJson, version);
    if (!parsed.ok) {
      throw this.verificationError('release_mismatch', `清单核验失败：${parsed.reason}`);
    }
    const manifest = parsed.manifest;

    // 三方一致性：清单摘要 == SHA256SUMS 行 == 实际下载后才可知（此处先与 SUMS 核对），
    // 大小 == GitHub 资产元数据；ZIP 摘要在执行器下载后再次校验。
    if (manifest.asset.name !== expectedAssetName) {
      throw this.verificationError('release_mismatch', '清单资产名与候选不一致');
    }
    if (manifest.asset.sha256 !== sums.get(expectedAssetName)) {
      throw this.verificationError('release_mismatch', '清单摘要与 SHA256SUMS 不一致');
    }
    if (manifest.asset.size !== zipAsset.size) {
      throw this.verificationError('release_mismatch', '清单大小与 GitHub 资产元数据不一致');
    }

    const publishedAt = release.published_at ?? manifest.publishedAt;
    let compatible = true;
    let compatibilityReason: UpdateCandidate['compatibilityReason'] = null;
    if (!manifest.programRollbackSafe) {
      compatible = false;
      compatibilityReason = 'rollback_unsafe';
    } else {
      const aboveFloor = compareSemver(currentVersion, manifest.minUpgradableVersion);
      if (aboveFloor === null || aboveFloor < 0) {
        compatible = false;
        compatibilityReason = 'below_min_upgradable';
      } else if (manifest.maxUpgradableVersion !== null) {
        const belowCeiling = compareSemver(currentVersion, manifest.maxUpgradableVersion);
        if (belowCeiling === null || belowCeiling > 0) {
          compatible = false;
          compatibilityReason = 'above_max_upgradable';
        }
      }
    }

    return {
      releaseId: release.id,
      releaseTag: release.tag_name,
      version,
      channel: 'stable',
      publishedAt,
      releaseNotes: this.sanitizeReleaseNotes(release.body),
      asset: {
        name: manifest.asset.name,
        size: manifest.asset.size,
        sha256: manifest.asset.sha256,
      },
      downloads: {
        assetUrl: zipAsset.browser_download_url,
        sumsUrl: sumsAsset.browser_download_url,
        sumsSha256: sha256Hex(sumsBytes),
        sumsSigUrl: sigAsset.browser_download_url,
        manifestUrl: manifestAsset.browser_download_url,
        manifestSha256: sha256Hex(manifestBytes),
      },
      manifest,
      compatible,
      compatibilityReason,
    };
  }

  private sanitizeReleaseNotes(body: string | null): string {
    if (!body) return '';
    // 只做防御性清理（去 NUL/控制字符），按纯文本交付；渲染责任在前端 pre-wrap。
    // eslint-disable-next-line no-control-regex
    return body.replace(/\u0000/g, '').replace(/[\u0001-\u0008\u000B\u000C\u000E-\u001F]/g, '');
  }

  private loadPublicKey(): string {
    if (this.publicKeyCache) return this.publicKeyCache;
    try {
      const pem = readFileSync(this.config.publicKeyPath, 'utf8');
      if (!pem.includes('BEGIN PUBLIC KEY')) {
        throw new Error('公钥文件格式非法');
      }
      this.publicKeyCache = pem;
      return pem;
    } catch {
      throw this.verificationError('public_key_missing', '缺少发布签名验证公钥');
    }
  }

  private resolveCandidateForCurrent(
    snapshot: CheckSnapshot | null,
    currentVersion: string,
  ): UpdateCandidate | null {
    if (!snapshot?.candidate) return null;
    const candidate = snapshot.candidate;
    const order = compareSemver(candidate.version, currentVersion);
    // 缓存候选已不高于当前版本（例如刚完成升级）时不再呈现。
    return order !== null && order > 0 ? candidate : null;
  }

  private async loadSnapshot(): Promise<CheckSnapshot | null> {
    if (this.snapshotLoaded) return this.snapshot;
    this.snapshotLoaded = true;
    try {
      const raw = await this.configCacheService.get(SNAPSHOT_KEY, '');
      if (!raw) return null;
      const parsed = JSON.parse(raw) as CheckSnapshot;
      if (parsed?.schemaVersion !== SNAPSHOT_SCHEMA_VERSION
        || typeof parsed.checkedAt !== 'string'
        || (parsed.etag !== null && typeof parsed.etag !== 'string')
        || (parsed.candidate !== null && typeof parsed.candidate !== 'object')
        || typeof parsed.latestStableVersion !== 'string' && parsed.latestStableVersion !== null) {
        this.logger.warn('更新检查快照结构非法，忽略。');
        return null;
      }
      this.snapshot = parsed;
    } catch {
      this.logger.warn('更新检查快照读取失败，忽略。');
    }
    return this.snapshot;
  }

  private async persistSnapshot(snapshot: CheckSnapshot): Promise<void> {
    this.snapshot = snapshot;
    try {
      await this.configCacheService.set(SNAPSHOT_KEY, JSON.stringify(snapshot), '系统更新检查快照（内部）');
    } catch (error) {
      // 快照落库失败只影响重启后的 stale 恢复，不阻塞本次检查结果。
      this.logger.warn(`更新检查快照落库失败：${error instanceof Error ? error.message : '未知错误'}`);
    }
  }

  private composeResultFromSnapshot(currentUnknown: boolean): UpdateCheckResult {
    const snapshot = this.snapshot;
    const currentVersion = currentUnknown ? VERSION_UNKNOWN : this.versionService.getCurrentVersion();
    const candidate = currentUnknown ? null : this.resolveCandidateForCurrent(snapshot, currentVersion);
    return {
      status: candidate ? 'update_available' : snapshot ? 'up_to_date' : 'error',
      stale: false,
      currentVersion,
      checkedAt: snapshot?.checkedAt ?? new Date().toISOString(),
      lastSuccessfulCheckAt: snapshot?.checkedAt ?? null,
      reason: snapshot ? null : 'current_version_unknown',
      reasonText: snapshot ? null : '尚未完成过版本检查',
      candidate,
      latestStableVersion: snapshot?.latestStableVersion ?? candidate?.version ?? null,
    };
  }

  private composeDisabledResult(): UpdateCheckResult {
    const snapshot = this.snapshot;
    return {
      status: 'disabled',
      stale: false,
      currentVersion: this.versionService.getCurrentVersion(),
      checkedAt: snapshot?.checkedAt ?? new Date().toISOString(),
      lastSuccessfulCheckAt: snapshot?.checkedAt ?? null,
      reason: null,
      reasonText: null,
      candidate: null,
      latestStableVersion: snapshot?.latestStableVersion ?? null,
    };
  }

  private staleResult(currentVersion: string, reason: UpdateFailureReason): UpdateCheckResult {
    const snapshot = this.snapshot;
    if (snapshot) {
      const candidate = currentVersion === VERSION_UNKNOWN
        ? null
        : this.resolveCandidateForCurrent(snapshot, currentVersion);
      return {
        status: 'stale',
        stale: true,
        currentVersion,
        checkedAt: new Date().toISOString(),
        lastSuccessfulCheckAt: snapshot.checkedAt,
        reason,
        reasonText: GITHUB_FAILURE_REASON_TEXT[reason as GithubFailureKind] ?? this.verificationReasonText(reason),
        candidate,
        latestStableVersion: snapshot.latestStableVersion,
      };
    }
    return this.errorResult(reason, undefined, currentVersion);
  }

  private errorResult(
    reason: UpdateFailureReason,
    text?: string,
    currentVersion?: string,
  ): UpdateCheckResult {
    return {
      status: 'error',
      stale: false,
      currentVersion: currentVersion ?? this.versionService.getCurrentVersion(),
      checkedAt: new Date().toISOString(),
      lastSuccessfulCheckAt: null,
      reason,
      reasonText: text ?? this.verificationReasonText(reason),
      candidate: null,
      latestStableVersion: null,
    };
  }

  private verificationReasonText(reason: UpdateFailureReason): string {
    switch (reason) {
      case 'current_version_unknown': return '无法确定当前运行版本';
      case 'public_key_missing': return '缺少发布签名验证公钥';
      case 'release_incomplete': return '候选 Release 资产不完整';
      case 'release_mismatch': return '候选 Release 可信核验未通过';
      default: return GITHUB_FAILURE_REASON_TEXT[reason];
    }
  }

  private verificationError(reason: UpdateFailureReason, message: string): Error {
    const error = new Error(message) as Error & { updateFailureReason?: UpdateFailureReason };
    error.updateFailureReason = reason;
    return error;
  }
}
