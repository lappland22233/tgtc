import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { spawn } from 'child_process';
import type { ChildProcess } from 'child_process';
import { copyFile, mkdir, readFile, writeFile } from 'fs/promises';
import { join } from 'path';
import { UpdateTask } from '../common/entities/update-task.entity';
import { VersionService } from '../version/version.service';
import { isTerminalStatus } from './update-state-machine';
import type { UpdateTaskStatus } from '../common/entities/update-task.entity';
import { UpdateTaskService } from './update-task.service';
import { UpdateService } from './update.service';
import { UpdateConfig, UPDATE_CONFIG } from './update.config';

/**
 * 后端写入 updater.sh 的任务描述（固定目录、uuid 命名）。
 * 字段集合是封闭集合，与 scripts/release/updater.sh 的解析器严格对齐。
 */
export interface UpdateTaskDescription {
  schemaVersion: 1;
  taskId: string;
  version: string;
  releaseTag: string;
  currentVersion: string;
  asset: { name: string; size: number; sha256: string; url: string };
  sums: { url: string; sha256: string };
  sumsSig: { url: string };
  manifest: { url: string; sha256: string };
  includesDbMigration: boolean;
  programRollbackSafe: boolean;
}

/** 状态机正向路径（顺序固定），用于把执行器回报的阶段逐步推进到 DB。 */
const FORWARD_PATH: readonly UpdateTaskStatus[] = [
  'queued', 'downloading', 'verifying', 'prechecking', 'backing_up',
  'extracting', 'migrating', 'activating', 'restarting', 'health_checking', 'succeeded',
];

const POLL_INTERVAL_MS = 5000;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * 更新执行器派发与同步服务。
 *
 * - 只写任务描述并调用固定入口（updater.sh），绝不拼接 shell、绝不传递任意路径。
 * - 心跳/状态文件轮询驱动 DB 状态机推进；进程退出码决定终态。
 * - 服务随升级被重启后：基于"运行版本 vs 任务目标版本"收敛激活后任务
 *   （成功 → succeeded；回退 → rolled_back），绝不盲目重跑。
 */
@Injectable()
export class UpdateRunnerService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(UpdateRunnerService.name);
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private activeChild: ChildProcess | null = null;
  private readonly dispatchedTaskIds = new Set<string>();
  private syncing = false;

  constructor(
    private readonly taskService: UpdateTaskService,
    private readonly updateService: UpdateService,
    private readonly versionService: VersionService,
    @Inject(UPDATE_CONFIG) private readonly config: UpdateConfig,
  ) {}

  /** 是否具备派发条件：安装开启、更新器入口与任务目录均已配置（仅 Linux）。 */
  canExecute(): boolean {
    return (
      this.config.installEnabled
      && process.platform === 'linux'
      && typeof this.config.updaterPath === 'string'
      && typeof this.config.taskDir === 'string'
    );
  }

  async onModuleInit(): Promise<void> {
    try {
      await this.recoverAfterRestart();
    } catch (error) {
      this.logger.warn(
        `更新任务重启恢复失败：${error instanceof Error ? error.message : '未知错误'}`,
      );
    }
    if (this.canExecute()) {
      this.pollTimer = setInterval(() => {
        void this.syncActiveTask();
      }, POLL_INTERVAL_MS);
      this.pollTimer.unref?.();
    }
  }

  onModuleDestroy(): void {
    if (this.pollTimer) clearInterval(this.pollTimer);
    // 不杀已派发的更新器：更新链路必须独立于后端生命周期完成或回退。
    this.activeChild = null;
  }

  /**
   * 派发任务：写入任务描述 JSON 并调用固定更新器入口（无 shell）。
   * 目录/入口未配置时任务保持 queued，等待运维补齐配置后重试派发。
   */
  async dispatch(task: UpdateTask): Promise<void> {
    if (!this.canExecute()) {
      this.logger.warn(
        '更新执行器未配置（UPDATE_INSTALL_ENABLED/UPDATE_UPDATER_PATH/UPDATE_TASK_DIR），任务保持 queued。',
      );
      return;
    }
    if (this.dispatchedTaskIds.has(task.taskId) || this.activeChild) {
      return; // 防止轮询重复派发同一任务或并发多进程
    }
    const taskDir = this.config.taskDir as string;
    await mkdir(taskDir, { recursive: true, mode: 0o750 });
    const description: UpdateTaskDescription = {
      schemaVersion: 1,
      taskId: task.taskId,
      version: task.targetVersion,
      releaseTag: task.releaseTag,
      currentVersion: task.currentVersion,
      asset: {
        name: (task.metadata?.asset as string) ?? `tgtc-v${task.targetVersion}-linux-x64.zip`,
        size: Number(task.metadata?.assetSize ?? 0),
        sha256: String(task.metadata?.assetSha256 ?? ''),
        url: String(task.metadata?.assetUrl ?? ''),
      },
      sums: {
        url: String(task.metadata?.sumsUrl ?? ''),
        sha256: String(task.metadata?.sumsSha256 ?? ''),
      },
      sumsSig: { url: String(task.metadata?.sumsSigUrl ?? '') },
      manifest: {
        url: String(task.metadata?.manifestUrl ?? ''),
        sha256: String(task.metadata?.manifestSha256 ?? ''),
      },
      includesDbMigration: task.metadata?.includesDbMigration === true,
      programRollbackSafe: task.metadata?.programRollbackSafe !== false,
    };
    if (!description.asset.url || !description.asset.sha256 || description.asset.size <= 0) {
      this.logger.error(`任务 ${task.taskId} 缺少制品下载锚点，无法派发。`);
      return;
    }
    // 描述文件名由服务生成的 uuid 组成，写入固定目录；更新器只信目录与 uuid。
    const safeName = UUID_PATTERN.test(task.taskId) ? task.taskId : null;
    if (!safeName) {
      this.logger.error(`任务 ID 非法，拒绝写入任务描述：${task.taskId}`);
      return;
    }
    await writeFile(
      join(taskDir, `${safeName}.json`),
      JSON.stringify(description, null, 2),
      { encoding: 'utf8', mode: 0o640 },
    );

    this.logger.log(`派发更新任务 ${task.taskId}（目标 ${task.targetVersion}）。`);
    this.dispatchedTaskIds.add(task.taskId);
    if (task.status === 'queued') {
      await this.taskService.transitionTask(task, 'downloading', { heartbeatAt: new Date() });
    }
    const child = spawn('sudo', ['-n', this.config.updaterPath as string, safeName], {
      stdio: 'ignore',
      detached: false,
    });
    this.activeChild = child;
    child.unref?.();
    child.on('exit', (code) => {
      if (this.activeChild === child) this.activeChild = null;
      this.logger.log(`更新器进程退出：task=${task.taskId} code=${code ?? 'signal'}`);
    });
    child.on('error', (error) => {
      if (this.activeChild === child) this.activeChild = null;
      this.logger.error(`更新器进程启动失败：${error.message}`);
    });
  }

  /**
   * 后端随升级重启后的收敛逻辑（不盲目重跑）：
   * - activating/restarting/health_checking：比对运行版本与任务目标版本；
   *   运行版本 == 目标 → 升级已成功；运行版本 == 任务起始版本 → 已回退；否则保守挂起。
   * - queued：执行器未跑过；具备派发条件时重新派发（downloading 起步由执行器推进）。
   * - 其余非终态：保持原状，由心跳轮询或人工处理。
   */
  async recoverAfterRestart(): Promise<void> {
    const activeTasks = await this.taskService.listTasks(50);
    for (const task of activeTasks) {
      if (task.isActive !== true || isTerminalStatus(task.status)) continue;
      // 单任务失败不得中止整体恢复循环，避免活动槽位连锁卡死。
      try {
        await this.recoverSingleTask(task);
      } catch (error) {
        this.logger.warn(
          `更新任务 ${task.taskId} 重启恢复失败：${error instanceof Error ? error.message : '未知错误'}`,
        );
      }
    }
  }

  private async recoverSingleTask(task: UpdateTask): Promise<void> {
    if (task.status === 'activating' || task.status === 'restarting' || task.status === 'health_checking') {
      const runningVersion = this.versionService.getCurrentVersion();
      if (runningVersion === task.targetVersion) {
        // 沿合法正向链逐级收敛到 succeeded（禁止跨阶跳转）。
        await this.walkForwardTo(task, 'succeeded');
        await this.updateService.recordTaskOutcome(task, 'succeeded');
        this.logger.log(`更新任务 ${task.taskId} 在重启后确认成功（运行版本 ${runningVersion}）。`);
      } else if (runningVersion === task.currentVersion) {
        await this.walkRollback(task, 'rolled_back');
        await this.updateService.recordTaskOutcome(task, 'rolled_back');
        this.logger.warn(`更新任务 ${task.taskId} 在重启后确认已回退。`);
      } else {
        this.logger.warn(`更新任务 ${task.taskId} 运行版本 ${runningVersion} 与预期不符，保持 ${task.status} 等待人工确认。`);
      }
    } else if (task.status === 'queued' && this.canExecute()) {
      await this.dispatch(task);
    }
  }

  /** 轮询：派发仍处 queued 的活动任务；读取状态/心跳文件推进 DB 状态机。 */
  private async syncActiveTask(): Promise<void> {
    if (this.syncing) return;
    this.syncing = true;
    try {
      const task = await this.taskService.findActiveTask();
      if (!task || isTerminalStatus(task.status)) return;
      if (task.status === 'queued') {
        await this.dispatch(task);
        return;
      }
      const taskDir = this.config.taskDir;
      if (!taskDir) return;
      const statePath = join(taskDir, `${task.taskId}.state`);
      let observed: string | null = null;
      try {
        observed = (await readFile(statePath, 'utf8')).trim();
      } catch {
        return; // 状态文件尚未产生
      }
      await this.applyObservedStatus(task, observed as UpdateTaskStatus);
    } catch (error) {
      this.logger.warn(`更新任务状态同步失败：${error instanceof Error ? error.message : '未知错误'}`);
    } finally {
      this.syncing = false;
    }
  }

  /** 把执行器回报的阶段同步为 DB 状态（只允许沿正向路径或回退路径前进）。 */
  private async applyObservedStatus(task: UpdateTask, observed: UpdateTaskStatus): Promise<void> {
    if (task.status === observed) {
      await this.touchHeartbeat(task);
      return;
    }
    // 回退路径：回报进入 rollback 流程或失败终态。
    if (observed === 'rollback_pending' || observed === 'rolling_back'
      || observed === 'rolled_back' || observed === 'rollback_failed') {
      await this.walkRollback(task, observed);
      if (isTerminalStatus(observed)) {
        const outcome = observed === 'rolled_back' ? 'rolled_back' : 'rollback_failed';
        await this.updateService.recordTaskOutcome(task, outcome);
      }
      return;
    }
    // 正向路径：沿固定顺序逐级推进（跳阶一律拒绝，防止状态机被越过）。
    await this.walkForwardTo(task, observed);
    await this.touchHeartbeat(task);
  }

  /** 沿正向路径逐级推进到目标状态；目标不在正向路径或已在之后时不做任何操作。 */
  private async walkForwardTo(task: UpdateTask, target: UpdateTaskStatus): Promise<void> {
    const fromIndex = FORWARD_PATH.indexOf(task.status);
    const toIndex = FORWARD_PATH.indexOf(target);
    if (fromIndex < 0 || toIndex <= fromIndex) return;
    let current = task;
    for (let index = fromIndex + 1; index <= toIndex; index++) {
      current = await this.taskService.transitionTask(current, FORWARD_PATH[index], { heartbeatAt: new Date() });
    }
  }

  private async walkRollback(
    task: UpdateTask,
    target: Extract<UpdateTaskStatus, 'rollback_pending' | 'rolling_back' | 'rolled_back' | 'rollback_failed'>,
  ): Promise<void> {
    let current = task;
    for (const status of ['rollback_pending', 'rolling_back', target] as const) {
      if (current.status === status) continue;
      current = await this.taskService.transitionTask(current, status, { heartbeatAt: new Date() });
    }
  }

  private async touchHeartbeat(task: UpdateTask): Promise<void> {
    try {
      await this.taskService.touchHeartbeat(task.taskId);
    } catch {
      // 心跳更新失败不影响状态同步；下轮轮询重试。
    }
  }

  /** 复制发布签名公钥到任务目录旁（部署侧离线验证备用；无副作用失败容忍）。 */
  async stagePublicKey(): Promise<string | null> {
    if (!this.config.taskDir) return null;
    try {
      const dest = join(this.config.taskDir, 'update-public-key.pem');
      await copyFile(this.config.publicKeyPath, dest);
      return dest;
    } catch {
      return null;
    }
  }
}
