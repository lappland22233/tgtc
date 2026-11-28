import { Controller, Get, ServiceUnavailableException } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bull';
import { Queue } from 'bull';
import { DataSource } from 'typeorm';
import { VersionService } from '../version/version.service';
import { QUEUE_NAMES } from '../jobs/bull-queue.module';

// 兼容导出：既有测试与外部调用方从此处获取版本读取原语（实现已统一收敛到 VersionService）。
export { readReleaseVersion } from '../version/version.service';

/** Redis 探活超时：探针自身不得被挂起的依赖拖住 */
const REDIS_PROBE_TIMEOUT_MS = 3000;

@Controller()
export class HealthController {
  constructor(
    private readonly dataSource: DataSource,
    private readonly versionService: VersionService,
    @InjectQueue(QUEUE_NAMES.FILE_UPLOAD) private readonly fileUploadQueue: Queue,
  ) {}

  @Get('health')
  async health(): Promise<{ status: 'ok'; database: 'ok'; redis: 'ok' }> {
    try {
      await this.dataSource.query('SELECT 1');
    } catch {
      // 探针须准确反映不可服务状态，但不返回数据库连接信息。
      throw new ServiceUnavailableException('服务依赖未就绪');
    }
    // Redis 不可用＝Bull 全部定时/上传/镜像任务静默停摆。旧探针只查 DB，此时仍返回
    // ok（假绿），运维与升级后健康检查都看不到故障，故必须一并探活。
    if (!(await this.probeRedis())) {
      throw new ServiceUnavailableException('任务队列依赖未就绪');
    }
    return { status: 'ok', database: 'ok', redis: 'ok' };
  }

  private async probeRedis(): Promise<boolean> {
    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        this.fileUploadQueue.client.ping().then(() => true),
        new Promise<false>((resolve) => {
          timer = setTimeout(() => resolve(false), REDIS_PROBE_TIMEOUT_MS);
          timer.unref?.();
        }),
      ]);
    } catch {
      return false;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  @Get('version')
  version(): { version: string } {
    return { version: this.versionService.getCurrentVersion() };
  }
}
