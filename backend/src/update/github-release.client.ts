import axios, { AxiosInstance } from 'axios';
import { GITHUB_API_BASE, UpdateConfig } from './update.config';

/** GitHub Releases API 原始响应（仅保留本链路使用的字段）。 */
export interface GithubReleaseRaw {
  id: number;
  tag_name: string;
  name: string | null;
  draft: boolean;
  prerelease: boolean;
  published_at: string | null;
  body: string | null;
  html_url: string;
  assets: Array<{
    id: number;
    name: string;
    size: number;
    browser_download_url: string;
  }>;
}

export type GithubFailureKind =
  | 'timeout'
  | 'network'
  | 'rate_limited'
  | 'forbidden'
  | 'not_found'
  | 'http_5xx'
  | 'http_4xx'
  | 'malformed';

interface AxiosLikeError {
  response?: { status?: number };
  code?: string;
  message?: string;
}

/**
 * 固定仓库的 GitHub Releases 客户端。
 *
 * - 仓库 owner/repo 来自 UpdateConfig（启动时固定），不接受调用方传入。
 * - 统一超时、User-Agent、Accept 与 API 版本头，响应体大小有硬上限。
 * - 支持 ETag 条件请求：304 直接透传给上层做缓存续期。
 * - 不做内部重试：上层（UpdateCheckService）持有缓存与降级逻辑，
 *   客户端保持无状态单次请求，避免重试放大限流。
 */
export class GithubReleaseClient {
  private readonly http: AxiosInstance;

  constructor(private readonly config: UpdateConfig) {
    this.http = axios.create({
      baseURL: GITHUB_API_BASE,
      timeout: config.checkTimeoutMs,
      // 响应体硬上限：Releases 列表 JSON 远小于此值，超限说明响应被篡改或异常。
      maxContentLength: 4 * 1024 * 1024,
      maxBodyLength: 4 * 1024 * 1024,
      headers: {
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': `tgtc-update-check/${config.githubOwner}/${config.githubRepo}`,
        ...(config.githubToken ? { Authorization: `Bearer ${config.githubToken}` } : {}),
      },
      // 304 需要作为正常返回处理。
      validateStatus: (status) => (status >= 200 && status < 300) || status === 304,
    });
  }

  /**
   * 拉取最新 Releases 列表（含 draft/prerelease，由上层过滤）。
   * etag 提供时走条件请求；304 时 releases 为 undefined。
   */
  async fetchReleases(etag?: string | null): Promise<{
    status: 200 | 304;
    releases: GithubReleaseRaw[] | undefined;
    etag: string | null;
  }> {
    const response = await this.http.get<GithubReleaseRaw[]>(
      `/repos/${this.config.githubOwner}/${this.config.githubRepo}/releases`,
      {
        params: { per_page: 15 },
        headers: etag ? { 'If-None-Match': etag } : undefined,
      },
    );
    if (response.status === 304) {
      return { status: 304, releases: undefined, etag: etag ?? null };
    }
    const releases = response.data;
    if (!Array.isArray(releases)) {
      throw this.malformedError('Releases 响应不是数组');
    }
    for (const release of releases) {
      if (!release || typeof release !== 'object'
        || typeof release.id !== 'number'
        || typeof release.tag_name !== 'string'
        || typeof release.draft !== 'boolean'
        || typeof release.prerelease !== 'boolean'
        || !Array.isArray(release.assets)) {
        throw this.malformedError('Releases 响应元素结构非法');
      }
    }
    const nextEtag = response.headers?.etag ?? null;
    return { status: 200, releases, etag: typeof nextEtag === 'string' ? nextEtag : null };
  }

  /**
   * 按 releaseId 精确获取单个 Release（安装前二次核验候选时使用，
   * 防止检查与安装之间候选被替换）。404 时返回 null。
   */
  async fetchReleaseById(releaseId: number): Promise<GithubReleaseRaw | null> {
    let response;
    try {
      response = await this.http.get<GithubReleaseRaw>(
        `/repos/${this.config.githubOwner}/${this.config.githubRepo}/releases/${encodeURIComponent(String(releaseId))}`,
      );
    } catch (error) {
      const status = (error as AxiosLikeError | null)?.response?.status;
      if (status === 404) return null;
      throw error;
    }
    const release = response.data;
    if (!release || typeof release !== 'object'
      || typeof release.id !== 'number'
      || typeof release.tag_name !== 'string'
      || typeof release.draft !== 'boolean'
      || typeof release.prerelease !== 'boolean'
      || !Array.isArray(release.assets)) {
      throw this.malformedError('Release 响应结构非法');
    }
    return release;
  }

  /**
   * 下载小制品（清单/SHA256SUMS/签名）为 Buffer，带大小上限。
   * 仅允许 GitHub 域名（资产 URL 必须来自 API 响应，这里再做主机白名单兜底）。
   * Token 不发往资产下载主机（最小披露：仅需匿名可读的 release 资产）。
   */
  async fetchAssetBytes(url: string, maxBytes: number): Promise<Buffer> {
    this.assertAllowedUrl(url);
    const response = await this.http.get<ArrayBuffer>(url, {
      responseType: 'arraybuffer',
      maxContentLength: maxBytes,
      maxBodyLength: maxBytes,
      headers: { Accept: 'application/octet-stream', Authorization: '' },
    });
    const data = Buffer.from(response.data);
    if (data.length > maxBytes) {
      throw this.malformedError('制品超出大小上限');
    }
    return data;
  }

  private assertAllowedUrl(url: string): void {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      throw this.malformedError('资产 URL 非法');
    }
    const allowedHosts = new Set(['github.com', 'objects.githubusercontent.com']);
    if (parsed.protocol !== 'https:' || !allowedHosts.has(parsed.hostname)) {
      throw this.malformedError('资产 URL 主机不在允许名单');
    }
  }

  private malformedError(detail: string): Error {
    const error = new Error(detail) as Error & { updateFailureKind?: GithubFailureKind };
    error.updateFailureKind = 'malformed';
    return error;
  }
}

/** 把 axios/网络错误归类为脱敏的失败原因代码（不含 URL、Token 或堆栈）。 */
export function classifyGithubError(error: unknown): GithubFailureKind {
  const kind = (error as { updateFailureKind?: GithubFailureKind } | null)?.updateFailureKind;
  if (kind) return kind;
  const candidate = error as AxiosLikeError | null;
  if (!candidate || typeof candidate !== 'object') return 'network';
  const status = candidate.response?.status;
  if (status === 403 || status === 429) return 'rate_limited';
  if (status === 404) return 'not_found';
  if (typeof status === 'number' && status >= 500) return 'http_5xx';
  if (typeof status === 'number') return 'http_4xx';
  const code = candidate.code ?? '';
  if (code === 'ECONNABORTED' || code === 'ETIMEDOUT') return 'timeout';
  if (code.startsWith('ERR_BAD_RESPONSE')) return 'http_5xx';
  if (code.startsWith('ERR_NETWORK') || code === 'ECONNREFUSED' || code === 'ENOTFOUND' || code === 'EAI_AGAIN') {
    return 'network';
  }
  return 'network';
}

/** 失败原因的用户可读（且安全）描述；供 API 返回，不含内部细节。 */
export const GITHUB_FAILURE_REASON_TEXT: Record<GithubFailureKind, string> = {
  timeout: '更新源请求超时',
  network: '更新源不可达',
  rate_limited: '更新源限流，请稍后重试',
  forbidden: '更新源拒绝访问',
  not_found: '更新源仓库不可用',
  http_5xx: '更新源服务异常',
  http_4xx: '更新源请求被拒绝',
  malformed: '更新源响应格式非法',
};
