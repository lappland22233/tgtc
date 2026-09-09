import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { spawn } from 'child_process';
import type { ChildProcess } from 'child_process';
import { copyFile, mkdir, readFile, stat, writeFile } from 'fs/promises';
import { join } from 'path';
import { UpdateTask } from '../common/entities/update-task.entity';
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
/** 心跳文件超过该时长未更新则不再刷新 DB 心跳（执行器疑似失联，交由超时收敛） */
const HEARTBEAT_FILE_STALE_MS = 60_000;

/**
 * 更新执行器派发与同步服务。
 *
 * - 只写任务描述并经 systemd oneshot 单元（tgtc-update@<taskId>.service）派发固定更新器入口，
 *   绝不拼接 shell、绝不传递任意路径。更新器运行在独立 cgroup：后端服务重启不会回收
 *   更新进程（P1-04），且后端（NoNewPrivileges）无需 sudo，由 polkit 限定仅可 start 本单元。
 * - 心跳/状态文件轮询驱动 DB 状态机推进；执行器失联超过 taskTimeoutMs 时，
 *   按状态机合法链收敛到 rollback_failed 并释放活动槽位（R2）。
 * - 服务随升级被重启后一律保守挂起（P1-07）：succeeded 终态只能由健康检查通过后的
 *   执行器（state 文件）上报，重启收敛不再产生终态，避免健康检查失败回退后任务仍显示成功。
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
    // P1-04：经独立 systemd oneshot 单元派发（--no-block 立即返回）。
    // 更新器在自身 cgroup 中运行，升级流程重启 tgtc.service 不会回收它；
    // 授权由部署时安装的 polkit 规则限定（仅允许服务用户 start tgtc-update@<uuid>.service）。
    // 后端单元 NoNewPrivileges=true 下 sudo 本就不可用，此路径是唯一可行通道。
    const child = spawn('systemctl', ['start', '--no-block', `tgtc-update@${safeName}.service`], {
      stdio: 'ignore',
    });
    this.activeChild = child;
    child.unref?.();
    child.on('exit', (code) => {
      if (this.activeChild === child) this.activeChild = null;
      // --no-block 下非零退出码通常表示 systemd 拒绝（单元不存在/未授权）；
      // 任务由 R2 心跳超时收敛，避免在轮询外直接改写状态机。
      if (code !== 0) {
        this.logger.error(`更新单元触发失败：task=${task.taskId} code=${code}（检查 tgtc-update@.service 与 polkit 规则）`);
      } else {
        this.logger.log(`更新单元已触发：task=${task.taskId}`);
      }
    });
    child.on('error', (error) => {
      if (this.activeChild === child) this.activeChild = null;
      this.logger.error(`更新单元触发失败：${error.message}`);
    });
  }

  /**
   * 后端随升级重启后的收敛逻辑（不盲目重跑、不产生终态）：
   * - P1-07：健康检查可能尚未执行（时序：切链→重启后端→本恢复逻辑→upgrade.sh 健康检查
   *   →失败自动回退）。此处若把"运行版本==目标"收敛为 succeeded，回退后任务将永久显示成功。
   *   因此激活后阶段一律保守挂起：终态只由执行器 state 文件（健康检查通过后写入 succeeded、
   *   失败回退写入 rolled_back）经轮询上报；执行器失联由 R2 心跳超时收敛为 rollback_failed。
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
      // P1-07：保守挂起——升级窗口内后端可能被重启多次（正常重启 + 健康检查失败回退），
      // 运行版本比对无法区分这两种情形，绝不在此产生终态。
      this.logger.warn(
        `更新任务 ${task.taskId} 处于 ${task.status}，保守挂起等待执行器回报终态（健康检查通过/回退后由 state 文件上报）。`,
      );
      return;
    }
    if (task.status === 'queued' && this.canExecute()) {
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
      // R2：执行器失联超时收敛。心跳（DB 或文件）超过 taskTimeoutMs 未更新，
      // 按状态机合法链收敛到 rollback_failed 并释放活动槽位，避免任务永久占槽。
      const lastSignalMs = task.heartbeatAt
        ? new Date(task.heartbeatAt).getTime()
        : task.startedAt
          ? new Date(task.startedAt).getTime()
          : Date.now();
      if (Date.now() - lastSignalMs > this.config.taskTimeoutMs) {
        this.logger.error(
          `更新任务 ${task.taskId} 执行器心跳超时（> ${this.config.taskTimeoutMs}ms），收敛为 rollback_failed。`,
        );
        await this.walkRollback(task, 'rollback_failed');
        await this.updateService.recordTaskOutcome(task, 'rollback_failed');
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
      await this.touchHeartbeatIfFresh(task);
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
    await this.touchHeartbeatIfFresh(task);
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
    // R1：只从当前状态在回退链上的下一环开始推进。
    // 此前固定重放 ['rollback_pending','rolling_back',target] 会对已处于 rolling_back 的任务
    // 再次尝试 rolling_back→rollback_pending（状态机拒绝），抛错后任务卡在 active 占槽，
    // 后续升级永久 409。按索引从当前位置起走，已越过的环不再重放。
    const chain: readonly UpdateTaskStatus[] = ['rollback_pending', 'rolling_back', target];
    const targetIndex = chain.indexOf(target);
    let current = task;
    for (let index = chain.indexOf(current.status) + 1; index <= targetIndex; index++) {
      current = await this.taskService.transitionTask(current, chain[index], { heartbeatAt: new Date() });
    }
  }

  /**
   * R2：仅当执行器心跳文件仍新鲜时才刷新 DB 心跳。
   * 此前只要 state 文件存在且状态未变就无条件刷心跳——执行器死亡后 DB 心跳永远新鲜，
   * 超时收敛永不触发，任务永久显示活跃。
   */
  private async touchHeartbeatIfFresh(task: UpdateTask): Promise<void> {
    const ageMs = await this.heartbeatFileAgeMs(task);
    if (ageMs !== null && ageMs > HEARTBEAT_FILE_STALE_MS) return;
    try {
      await this.taskService.touchHeartbeat(task.taskId);
    } catch {
      // 心跳更新失败不影响状态同步；下轮轮询重试。
    }
  }

  private async heartbeatFileAgeMs(task: UpdateTask): Promise<number | null> {
    const taskDir = this.config.taskDir;
    if (!taskDir) return null;
    try {
      const info = await stat(join(taskDir, `${task.taskId}.heartbeat`));
      return Date.now() - info.mtimeMs;
    } catch {
      return null;
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
