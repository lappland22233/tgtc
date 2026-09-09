import axios from 'axios';
import { GithubReleaseClient, classifyGithubError } from './github-release.client';
import { loadUpdateConfig } from './update.config';

jest.mock('axios');
const mockedAxios = axios as jest.Mocked<typeof axios>;
const mockedCreate = mockedAxios.create as jest.Mock;

function buildClient(overrides: Record<string, string> = {}) {
  const config = loadUpdateConfig(overrides);
  return new GithubReleaseClient(config);
}

const validRelease = {
  id: 7,
  tag_name: 'v1.1.0',
  name: 'TGTC v1.1.0',
  draft: false,
  prerelease: false,
  published_at: '2026-09-01T00:00:00Z',
  body: 'notes',
  html_url: 'https://github.com/lappland22233/tgtc/releases/tag/v1.1.0',
  assets: [{
    id: 1,
    name: 'tgtc-v1.1.0-linux-x64.zip',
    size: 1234,
    browser_download_url: 'https://github.com/lappland22233/tgtc/releases/download/v1.1.0/tgtc-v1.1.0-linux-x64.zip',
  }],
};

describe('GithubReleaseClient', () => {
  let httpGet: jest.Mock;

  beforeEach(() => {
    jest.clearAllMocks();
    httpGet = jest.fn();
    mockedCreate.mockReturnValue({ get: httpGet } as unknown as ReturnType<typeof axios.create>);
  });

  it('设置固定 UA、Accept 与 API 版本头；配置 Token 时附带 Authorization', () => {
    buildClient({ UPDATE_GITHUB_TOKEN: 'secret-token' });
    const axiosConfig = mockedCreate.mock.calls[0][0];
    expect(axiosConfig.baseURL).toBe('https://api.github.com');
    expect(axiosConfig.headers['User-Agent']).toBe('tgtc-update-check/lappland22233/tgtc');
    expect(axiosConfig.headers.Accept).toBe('application/vnd.github+json');
    expect(axiosConfig.headers.Authorization).toBe('Bearer secret-token');
  });

  it('未配置 Token 时不携带 Authorization 头', () => {
    buildClient();
    expect(mockedCreate.mock.calls[0][0].headers.Authorization).toBeUndefined();
  });

  it('200 响应返回 Releases 列表与 ETag', async () => {
    httpGet.mockResolvedValue({ status: 200, data: [validRelease], headers: { etag: 'W/"abc"' } });
    const client = buildClient();

    const result = await client.fetchReleases();

    expect(result.status).toBe(200);
    expect(result.releases).toHaveLength(1);
    expect(result.etag).toBe('W/"abc"');
    expect(httpGet).toHaveBeenCalledWith(
      '/repos/lappland22233/tgtc/releases',
      expect.objectContaining({ params: { per_page: 15 } }),
    );
  });

  it('携带 ETag 发起条件请求并透传 304', async () => {
    httpGet.mockResolvedValue({ status: 304, data: undefined, headers: {} });
    const client = buildClient();

    const result = await client.fetchReleases('W/"abc"');

    expect(result).toEqual({ status: 304, releases: undefined, etag: 'W/"abc"' });
    expect(httpGet).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ headers: expect.objectContaining({ 'If-None-Match': 'W/"abc"' }) }),
    );
  });

  it('200 响应不是数组或元素结构非法时抛出 malformed', async () => {
    const client = buildClient();
    httpGet.mockResolvedValueOnce({ status: 200, data: { unexpected: true }, headers: {} });
    await expect(client.fetchReleases()).rejects.toMatchObject({ updateFailureKind: 'malformed' });

    const broken = { ...validRelease, tag_name: 123 } as unknown as typeof validRelease;
    httpGet.mockResolvedValueOnce({ status: 200, data: [broken], headers: {} });
    await expect(client.fetchReleases()).rejects.toMatchObject({ updateFailureKind: 'malformed' });
  });

  it('fetchReleaseById 404 返回 null，结构非法抛 malformed', async () => {
    const client = buildClient();
    httpGet.mockRejectedValueOnce({ response: { status: 404 } });
    await expect(client.fetchReleaseById(999)).resolves.toBeNull();

    httpGet.mockResolvedValueOnce({ status: 200, data: { id: 'bad' } });
    await expect(client.fetchReleaseById(7)).rejects.toMatchObject({ updateFailureKind: 'malformed' });
  });

  it('fetchAssetBytes 拒绝非 GitHub 主机与非 HTTPS', async () => {
    const client = buildClient();
    await expect(client.fetchAssetBytes('http://github.com/a', 1024)).rejects.toMatchObject({ updateFailureKind: 'malformed' });
    await expect(client.fetchAssetBytes('https://evil.example.com/a.zip', 1024)).rejects.toMatchObject({ updateFailureKind: 'malformed' });
    await expect(client.fetchAssetBytes('not-a-url', 1024)).rejects.toMatchObject({ updateFailureKind: 'malformed' });
  });

  it('fetchAssetBytes 允许 github.com 与 objects.githubusercontent.com 并传递大小上限', async () => {
    const client = buildClient();
    httpGet.mockResolvedValue({ status: 200, data: new Uint8Array([1, 2, 3]).buffer });
    await expect(client.fetchAssetBytes('https://github.com/a/b', 1024)).resolves.toEqual(Buffer.from([1, 2, 3]));
    expect(httpGet).toHaveBeenCalledWith('https://github.com/a/b', expect.objectContaining({ maxContentLength: 1024 }));

    httpGet.mockResolvedValue({ status: 200, data: new Uint8Array([1]).buffer });
    await expect(client.fetchAssetBytes('https://objects.githubusercontent.com/x', 1024)).resolves.toEqual(Buffer.from([1]));
  });
});

describe('classifyGithubError', () => {
  it('按状态码与传输错误归类', () => {
    expect(classifyGithubError({ response: { status: 403 } })).toBe('rate_limited');
    expect(classifyGithubError({ response: { status: 429 } })).toBe('rate_limited');
    expect(classifyGithubError({ response: { status: 404 } })).toBe('not_found');
    expect(classifyGithubError({ response: { status: 502 } })).toBe('http_5xx');
    expect(classifyGithubError({ response: { status: 418 } })).toBe('http_4xx');
    expect(classifyGithubError({ code: 'ETIMEDOUT' })).toBe('timeout');
    expect(classifyGithubError({ code: 'ECONNABORTED' })).toBe('timeout');
    expect(classifyGithubError({ code: 'ENOTFOUND' })).toBe('network');
    expect(classifyGithubError(null)).toBe('network');
  });

  it('显式标记的 malformed 优先返回', () => {
    const error = Object.assign(new Error('x'), { updateFailureKind: 'malformed' });
    expect(classifyGithubError(error)).toBe('malformed');
  });
});
