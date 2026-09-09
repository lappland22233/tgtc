import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { loadUpdateConfig, UpdateConfig } from './update.config';
import { UpdateRunnerService } from './update-runner.service';
import { UpdateTask } from '../common/entities/update-task.entity';
import { UpdateTaskService } from './update-task.service';
import { UpdateService } from './update.service';

jest.mock('child_process', () => ({
  ...jest.requireActual('child_process'),
  spawn: jest.fn(() => ({ unref: jest.fn(), on: jest.fn() })),
}));

import { spawn } from 'child_process';
const mockedSpawn = spawn as jest.Mock;

function buildTask(overrides: Partial<UpdateTask> = {}): UpdateTask {
  return {
    taskId: 'a1b2c3d4-e5f6-4a1b-8c9d-0123456789ab',
    requestedBy: 'user-1',
    currentVersion: '1.0.0',
    targetVersion: '1.1.0',
    releaseId: 42,
    releaseTag: 'v1.1.0',
    status: 'queued',
    progress: 0,
    isActive: true,
    errorCode: null,
    errorSummary: null,
    rollbackStatus: null,
    metadata: {
      assetSha256: 'a'.repeat(64),
      assetSize: 1234,
      assetUrl: 'https://github.com/lappland22233/tgtc/releases/download/v1.1.0/tgtc-v1.1.0-linux-x64.zip',
      sumsUrl: 'https://github.com/lappland22233/tgtc/releases/download/v1.1.0/SHA256SUMS',
      sumsSha256: 'b'.repeat(64),
      sumsSigUrl: 'https://github.com/lappland22233/tgtc/releases/download/v1.1.0/SHA256SUMS.sig',
      manifestUrl: 'https://github.com/lappland22233/tgtc/releases/download/v1.1.0/release-manifest.json',
      manifestSha256: 'c'.repeat(64),
      includesDbMigration: false,
      programRollbackSafe: true,
    },
    startedAt: new Date(),
    finishedAt: null,
    heartbeatAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  } as UpdateTask;
}

describe('UpdateRunnerService', () => {
  let taskDir: string;
  let config: UpdateConfig;
  let transitions: Array<{ task: UpdateTask; to: string }>;
  let taskFixture: UpdateTask;
  let taskService: {
    findActiveTask: jest.Mock;
    findTask: jest.Mock;
    listTasks: jest.Mock;
    transitionTask: jest.Mock;
    touchHeartbeat: jest.Mock;
  };
  let updateService: { recordTaskOutcome: jest.Mock };

  let originalPlatform: NodeJS.Platform;

  beforeAll(() => {
    taskDir = mkdtempSync(join(tmpdir(), 'tgtc-runner-'));
  });

  afterAll(() => {
    rmSync(taskDir, { recursive: true, force: true });
  });

  beforeEach(() => {
    // dispatch 依赖 Linux 平台判断；测试中统一模拟为 linux。
    originalPlatform = process.platform;
    Object.defineProperty(process, 'platform', { value: 'linux' });
  });

  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: originalPlatform });
  });

  beforeEach(() => {
    jest.clearAllMocks();
    mockedSpawn.mockClear();
    taskFixture = buildTask();
    transitions = [];
    config = {
      ...loadUpdateConfig({ UPDATE_INSTALL_ENABLED: 'true' }),
      taskDir,
      updaterPath: '/opt/tgtc/current/scripts/release/updater.sh',
    };
    taskService = {
      findActiveTask: jest.fn().mockResolvedValue(taskFixture),
      findTask: jest.fn().mockResolvedValue(taskFixture),
      listTasks: jest.fn().mockResolvedValue([taskFixture]),
      transitionTask: jest.fn().mockImplementation((task: UpdateTask, to: string, patch: object) => {
        const next = { ...task, status: to, ...patch } as UpdateTask;
        transitions.push({ task, to });
        Object.assign(taskFixture, next);
        return Promise.resolve(next);
      }),
      touchHeartbeat: jest.fn().mockResolvedValue(undefined),
    };
    updateService = { recordTaskOutcome: jest.fn().mockResolvedValue(undefined) };
  });

  function buildRunner(overrides: Partial<UpdateConfig> = {}) {
    return new UpdateRunnerService(
      taskService as unknown as UpdateTaskService,
      updateService as unknown as UpdateService,
      { ...config, ...overrides },
    );
  }

  it('canExecute：仅在 Linux 且入口/目录/安装开关齐备时为真', () => {
    expect(buildRunner().canExecute()).toBe(true);
    expect(buildRunner({ installEnabled: false }).canExecute()).toBe(false);
    expect(buildRunner({ updaterPath: null }).canExecute()).toBe(false);
    expect(buildRunner({ taskDir: null }).canExecute()).toBe(false);
    Object.defineProperty(process, 'platform', { value: 'win32' });
    expect(buildRunner().canExecute()).toBe(false);
  });

  it('dispatch：写入任务描述 JSON 并经独立 oneshot 单元派发（P1-04）', async () => {
    const runner = buildRunner();
    await runner.dispatch(taskFixture);

    const jsonPath = join(taskDir, `${taskFixture.taskId}.json`);
    expect(existsSync(jsonPath)).toBe(true);
    const description = JSON.parse(readFileSync(jsonPath, 'utf8'));
    expect(description).toMatchObject({
      schemaVersion: 1,
      taskId: taskFixture.taskId,
      version: '1.1.0',
      currentVersion: '1.0.0',
      includesDbMigration: false,
      programRollbackSafe: true,
    });
    expect(description.asset.sha256).toHaveLength(64);
    // P1-04：更新器必须经 systemd oneshot 单元派发（独立 cgroup + 无 sudo 依赖）。
    expect(mockedSpawn).toHaveBeenCalledWith(
      'systemctl',
      ['start', '--no-block', `tgtc-update@${taskFixture.taskId}.service`],
      expect.objectContaining({ stdio: 'ignore' }),
    );
    expect(transitions.map((entry) => entry.to)).toEqual(['downloading']);
  });

  it('dispatch：未配置时保持 queued 且不写文件', async () => {
    rmSync(join(taskDir, `${taskFixture.taskId}.json`), { force: true });
    const runner = buildRunner({ installEnabled: false });
    await runner.dispatch(taskFixture);

    expect(mockedSpawn).not.toHaveBeenCalled();
    expect(transitions).toEqual([]);
    expect(existsSync(join(taskDir, `${taskFixture.taskId}.json`))).toBe(false);
  });

  it('状态同步：按正向路径逐级推进，不跳阶', async () => {
    const runner = buildRunner();
    taskFixture.status = 'prechecking';
    writeFileSync(join(taskDir, `${taskFixture.taskId}.state`), 'activating\n');

    await (runner as unknown as { syncActiveTask(): Promise<void> }).syncActiveTask();

    expect(transitions.map((entry) => entry.to)).toEqual(['backing_up', 'extracting', 'migrating', 'activating']);
    expect(taskService.touchHeartbeat).toHaveBeenCalled();
  });

  it('状态同步：回退路径按 rollback_pending → rolling_back → rolled_back 收敛并记录审计', async () => {
    const runner = buildRunner();
    taskFixture.status = 'activating';
    writeFileSync(join(taskDir, `${taskFixture.taskId}.state`), 'rolled_back\n');

    await (runner as unknown as { syncActiveTask(): Promise<void> }).syncActiveTask();

    expect(transitions.map((entry) => entry.to)).toEqual(['rollback_pending', 'rolling_back', 'rolled_back']);
    expect(updateService.recordTaskOutcome).toHaveBeenCalledWith(expect.anything(), 'rolled_back');
  });

  it('P1-07：激活后阶段重启恢复一律保守挂起，不产生终态', async () => {
    // 时序：切链→重启后端→恢复逻辑→upgrade.sh 健康检查→可能失败回退。
    // 运行版本==目标不代表最终成功（健康检查可能尚未执行），终态只能由执行器上报。
    taskFixture.status = 'health_checking';

    const runner = buildRunner();
    await runner.recoverAfterRestart();

    expect(transitions).toEqual([]);
    expect(updateService.recordTaskOutcome).not.toHaveBeenCalled();
  });

  it('P1-07：restarting 阶段重启恢复同样保守挂起（不能误判为已回退）', async () => {
    taskFixture.status = 'restarting';

    const runner = buildRunner();
    await runner.recoverAfterRestart();

    expect(transitions).toEqual([]);
    expect(updateService.recordTaskOutcome).not.toHaveBeenCalled();
  });

  it('状态同步：rolling_back 观测到 rolled_back 直接收敛，不再重放 rollback_pending（R1）', async () => {
    const runner = buildRunner();
    taskFixture.status = 'rolling_back';
    writeFileSync(join(taskDir, `${taskFixture.taskId}.state`), 'rolled_back\n');

    await (runner as unknown as { syncActiveTask(): Promise<void> }).syncActiveTask();

    expect(transitions.map((entry) => entry.to)).toEqual(['rolled_back']);
    expect(updateService.recordTaskOutcome).toHaveBeenCalledWith(expect.anything(), 'rolled_back');
  });
});
