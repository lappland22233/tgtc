import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { UpdateTask } from '../common/entities/update-task.entity';
import { VersionModule } from '../version/version.module';
import { GithubReleaseClient } from './github-release.client';
import { UpdateCheckService } from './update-check.service';
import { UpdateController } from './update.controller';
import { loadUpdateConfig, UPDATE_CONFIG } from './update.config';
import { UpdateService } from './update.service';
import { UpdateTaskService } from './update-task.service';
import { UpdateRunnerService } from './update-runner.service';

/**
 * 系统更新模块。
 *
 * UPDATE_CONFIG 在启动时由 loadUpdateConfig 一次性加载并校验（非法值使启动失败），
 * 模块内以只读令牌共享；GithubReleaseClient 基于该配置构造固定仓库客户端。
 */
@Module({
  imports: [TypeOrmModule.forFeature([UpdateTask]), VersionModule],
  controllers: [UpdateController],
  providers: [
    {
      provide: UPDATE_CONFIG,
      useValue: loadUpdateConfig(),
    },
    {
      provide: GithubReleaseClient,
      useFactory: (config: ReturnType<typeof loadUpdateConfig>) => new GithubReleaseClient(config),
      inject: [UPDATE_CONFIG],
    },
    UpdateCheckService,
    UpdateTaskService,
    UpdateService,
    UpdateRunnerService,
  ],
  exports: [UpdateCheckService, UpdateTaskService, UpdateService, UpdateRunnerService, UPDATE_CONFIG],
})
export class UpdateModule {}
