import { PublicConfigService } from './public-config.service';
import { VersionService } from '../version/version.service';

jest.mock('fs/promises', () => ({ readFile: jest.fn() }));

describe('PublicConfigService', () => {
  const configCacheService = {
    get: jest.fn(),
  };
  const versionService = {
    getCurrentVersion: jest.fn(() => 'unknown'),
  } as unknown as VersionService;

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('只返回固定 DTO 白名单，并从 VersionService 读取 SITE_TITLE 和运行版本', async () => {
    configCacheService.get.mockResolvedValue('  TGTC Beta  ');
    (versionService.getCurrentVersion as jest.Mock).mockReturnValue('1.2.3');
    const service = new PublicConfigService(configCacheService as any, versionService);

    await expect(service.getPublicConfig()).resolves.toEqual({
      siteTitle: 'TGTC Beta',
      version: '1.2.3',
    });
    expect(configCacheService.get).toHaveBeenCalledWith('SITE_TITLE', '文件分发系统');
  });

  it('SITE_TITLE 为空或 VERSION 不可读取时使用安全回退值', async () => {
    configCacheService.get.mockResolvedValue('   ');
    (versionService.getCurrentVersion as jest.Mock).mockReturnValue('unknown');
    const service = new PublicConfigService(configCacheService as any, versionService);

    await expect(service.getPublicConfig()).resolves.toEqual({
      siteTitle: '文件分发系统',
      version: 'unknown',
    });
  });
});
