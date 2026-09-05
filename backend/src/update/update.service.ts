import { BadRequestException, ConflictException, Inject, Injectable, Logger } from '@nestjs/common';
import { AuditService } from '../common/services/audit.service';
import { UpdateTask } from '../common/entities/update-task.entity';
import { compareSemver } from '../version/semver';
import { VersionService } from '../version/version.service';
import { UpdateCandidate, UpdateCheckService, UpdateCheckResult } from './update-check.service';
import { UpdateConfig, UPDATE_CONFIG } from './update.config';
import { UpdateTaskService } from './update-task.service';

/** 对外可见的任务元数据白名单（绝不暴露内部路径、备份位置） */
const EXPOSED_METADATA_KEYS = ['assetSha256', 'includesDbMigration', 'programRollbackSafe'] as const;

export interface UpdateTaskSummary {
  taskId: string;
  currentVersion: string;
  targetVersion: string;
  releaseId: number;
  releaseTag: string;
  status: UpdateTask['status'];
  progress: number;
  errorCode: string | null;
  errorSummary: string | null;
  rollbackStatus: UpdateTask['rollbackStatus'];
  startedAt: string | null;
  finishedAt: string | null;
  requestedBy: string;
  metadata: Record<string, unknown> | null;
}

export type UpdateStatusResponse = UpdateCheckResult & {
  checkEnabled: boolean;
  installEnabled: boolean;
  activeTask: UpdateTaskSummary | null;
};

const COMPATIBILITY_REASON_TEXT: Record<NonNullable<UpdateCandidate['compatibilityReason']>, string> = {
  below_min_upgradable: '当前版本低于该版本允许的最低升级起点，需按运维文档人工升级',
  above_max_upgradable: '当前版本高于该版本允许的最高自动升级范围',
  rollback_unsafe: '该版本不支持安全的程序回退，已阻止自动安装',
};

/**
 * 更新链路编排服务：状态聚合、检查、安装（含候选二次核验）、历史与取消。
 * 全部审计在此层统一落库；错误对外只暴露脱敏原因。
 */
@Injectable()
export class UpdateService {
  private readonly logger = new Logger(UpdateService.name);

  constructor(
    private readonly versionService: VersionService,
    private readonly checkService: UpdateCheckService,
    private readonly taskService: UpdateTaskService,
    @Inject(UPDATE_CONFIG) private readonly config: UpdateConfig,
    private readonly auditService: AuditService,
  ) {}

  async getStatus(): Promise<UpdateStatusResponse> {
    const [check, activeTask] = await Promise.all([
      this.checkService.getStatus(),
      this.taskService.findActiveTask(),
    ]);
    return { ...check, activeTask: activeTask ? this.toSummary(activeTask) : null };
  }

  async check(userId: string, ip: string): Promise<UpdateCheckResult> {
    await this.auditService.logAwait({
      action: 'update_check',
      userId,
      ip,
      resourceType: 'update',
    });
    return this.checkService.check(true);
  }

  async install(userId: string, ip: string, releaseId: number): Promise<UpdateTaskSummary> {
    if (!this.config.installEnabled) {
      throw new BadRequestException('安装功能未启用（UPDATE_INSTALL_ENABLED=false）');
    }
    const currentVersion = this.versionService.getCurrentVersion();
    if (currentVersion === 'unknown') {
      throw new BadRequestException('无法确定当前运行版本，拒绝安装');
    }

    // 安装前基于 releaseId 重新核验候选，防止检查与安装之间候选被替换。
    const candidate = await this.checkService.getVerifiedCandidate(releaseId, currentVersion)
      .catch((error: unknown) => {
        const reason = (error as { updateFailureReason?: string }).updateFailureReason ?? 'release_mismatch';
        this.logger.warn(`安装候选核验失败：${reason}`);
        throw new BadRequestException('候选 Release 可信核验未通过，请重新检查更新');
      });

    const order = compareSemver(candidate.version, currentVersion);
    if (order === null || order <= 0) {
      throw new BadRequestException('目标版本不高于当前版本，禁止降级或重复安装');
    }
    if (!candidate.compatible) {
      throw new BadRequestException(
        COMPATIBILITY_REASON_TEXT[candidate.compatibilityReason ?? 'rollback_unsafe'],
      );
    }

    const result = await this.taskService.createTask({
      requestedBy: userId,
      currentVersion,
      targetVersion: candidate.version,
      releaseId: candidate.releaseId,
      releaseTag: candidate.releaseTag,
      metadata: {
        assetSha256: candidate.asset.sha256,
        assetSize: candidate.asset.size,
        assetUrl: candidate.downloads.assetUrl,
        sumsUrl: candidate.downloads.sumsUrl,
        sumsSha256: candidate.downloads.sumsSha256,
        sumsSigUrl: candidate.downloads.sumsSigUrl,
        manifestUrl: candidate.downloads.manifestUrl,
        manifestSha256: candidate.downloads.manifestSha256,
        includesDbMigration: candidate.manifest.includesDbMigration,
        programRollbackSafe: candidate.manifest.programRollbackSafe,
        candidateSnapshot: {
          version: candidate.version,
          publishedAt: candidate.publishedAt,
          asset: candidate.asset,
          minUpgradableVersion: candidate.manifest.minUpgradableVersion,
          maxUpgradableVersion: candidate.manifest.maxUpgradableVersion,
          healthCheck: candidate.manifest.healthCheck,
        },
      },
    });
    if (result.conflict) {
      throw new ConflictException({
        message: '已有进行中的更新任务，无法创建新任务',
        activeTaskId: result.conflict.taskId,
      });
    }

    await this.auditService.logAwait({
      action: 'update_install',
      userId,
      ip,
      resourceType: 'update_task',
      resourceId: result.task.taskId,
      metadata: {
        targetVersion: candidate.version,
        releaseTag: candidate.releaseTag,
        releaseId: candidate.releaseId,
      },
    });
    return this.toSummary(result.task);
  }

  async getTask(taskId: string): Promise<UpdateTaskSummary> {
    const task = await this.taskService.findTask(taskId);
    if (!task) throw new BadRequestException('更新任务不存在');
    return this.toSummary(task);
  }

  async listTasks(limit = 10): Promise<UpdateTaskSummary[]> {
    const tasks = await this.taskService.listTasks(limit);
    return tasks.map((task) => this.toSummary(task));
  }

  async cancel(userId: string, ip: string, taskId: string): Promise<UpdateTaskSummary> {
    const task = await this.taskService.findTask(taskId);
    if (!task) throw new BadRequestException('更新任务不存在');
    if (!task.isActive) throw new BadRequestException('更新任务已结束，无法取消');

    const cancelled = await this.taskService.cancelTask(task)
      .catch((error: unknown) => {
        if (error instanceof Error && error.name === 'UpdateStateTransitionError') {
          throw new ConflictException({
            message: '任务已进入不可取消阶段',
            status: task.status,
          });
        }
        throw error;
      });

    await this.auditService.logAwait({
      action: 'update_cancel',
      userId,
      ip,
      resourceType: 'update_task',
      resourceId: taskId,
      metadata: { statusBefore: task.status, targetVersion: task.targetVersion },
    });
    return this.toSummary(cancelled);
  }

  /**
   * 任务终态审计（由更新执行器在任务成功/失败/回退时调用）。
   * 不修改任务本身，只负责把结果写入审计链。
   */
  async recordTaskOutcome(
    task: UpdateTask,
    outcome: 'succeeded' | 'failed' | 'rolled_back' | 'rollback_failed',
  ): Promise<void> {
    const action = outcome === 'succeeded'
      ? 'update_succeeded'
      : outcome === 'rolled_back'
        ? 'update_rollback'
        : outcome === 'rollback_failed'
          ? 'update_failed'
          : 'update_failed';
    await this.auditService.logAwait({
      action,
      userId: task.requestedBy,
      ip: null,
      resourceType: 'update_task',
      resourceId: task.taskId,
      metadata: {
        fromVersion: task.currentVersion,
        toVersion: task.targetVersion,
        releaseTag: task.releaseTag,
        errorCode: task.errorCode,
      },
    });
  }

  private toSummary(task: UpdateTask): UpdateTaskSummary {
    const metadata: Record<string, unknown> = {};
    for (const key of EXPOSED_METADATA_KEYS) {
      if (task.metadata && key in task.metadata) {
        metadata[key] = task.metadata[key];
      }
    }
    return {
      taskId: task.taskId,
      currentVersion: task.currentVersion,
      targetVersion: task.targetVersion,
      releaseId: task.releaseId,
      releaseTag: task.releaseTag,
      status: task.status,
      progress: task.progress,
      errorCode: task.errorCode,
      errorSummary: task.errorSummary,
      rollbackStatus: task.rollbackStatus,
      startedAt: task.startedAt ? new Date(task.startedAt).toISOString() : null,
      finishedAt: task.finishedAt ? new Date(task.finishedAt).toISOString() : null,
      requestedBy: task.requestedBy,
      metadata,
    };
  }
}
