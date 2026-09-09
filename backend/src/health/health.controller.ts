import { Controller, Get, ServiceUnavailableException } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { VersionService } from '../version/version.service';

// 兼容导出：既有测试与外部调用方从此处获取版本读取原语（实现已统一收敛到 VersionService）。
export { readReleaseVersion } from '../version/version.service';

@Controller()
export class HealthController {
  constructor(
    private readonly dataSource: DataSource,
    private readonly versionService: VersionService,
  ) {}

  @Get('health')
  async health(): Promise<{ status: 'ok'; database: 'ok' }> {
    try {
      await this.dataSource.query('SELECT 1');
      return { status: 'ok', database: 'ok' };
    } catch {
      // 探针须准确反映不可服务状态，但不返回数据库连接信息。
      throw new ServiceUnavailableException('服务依赖未就绪');
    }
  }

  @Get('version')
  version(): { version: string } {
    return { version: this.versionService.getCurrentVersion() };
  }
}
