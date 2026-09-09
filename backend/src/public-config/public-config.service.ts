import { Injectable } from '@nestjs/common';
import { ConfigCacheService } from '../common/services/config-cache.service';
import { VersionService } from '../version/version.service';
import { PublicConfigDto } from './public-config.dto';

const DEFAULT_SITE_TITLE = '文件分发系统';

@Injectable()
export class PublicConfigService {
  constructor(
    private readonly configCacheService: ConfigCacheService,
    private readonly versionService: VersionService,
  ) {}

  async getPublicConfig(): Promise<PublicConfigDto> {
    const [siteTitle, version] = await Promise.all([
      this.configCacheService.get('SITE_TITLE', DEFAULT_SITE_TITLE),
      Promise.resolve(this.versionService.getCurrentVersion()),
    ]);

    return {
      siteTitle: siteTitle.trim() || DEFAULT_SITE_TITLE,
      version,
    };
  }
}
