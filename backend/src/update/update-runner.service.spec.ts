import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { loadUpdateConfig, UpdateConfig } from './update.config';
import { UpdateRunnerService } from './update-runner.service';
import { UpdateTask } from '../common/entities/update-task.entity';
import { UpdateTaskService } from './update-task.service';
import { UpdateService } from './update.service';
import { VersionService } from '../version/version.service';

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
  let versionService: { getCurrentVersion: jest.Mock };

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
    versionService = { getCurrentVersion: jest.fn(() => '1.0.0') };
  });

  function buildRunner(overrides: Partial<UpdateConfig> = {}) {
    return new UpdateRunnerService(
      taskService as unknown as UpdateTaskService,
      updateService as unknown as UpdateService,
      versionService as unknown as VersionService,
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

  it('dispatch：写入任务描述 JSON 并以固定参数调用更新器（无 shell）', async () => {
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
    expect(mockedSpawn).toHaveBeenCalledWith(
      'sudo',
      ['-n', '/opt/tgtc/current/scripts/release/updater.sh', taskFixture.taskId],
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

  it('重启恢复：运行版本等于目标版本 → succeeded 并记录成功审计', async () => {
    versionService.getCurrentVersion.mockReturnValue('1.1.0');
    taskFixture.status = 'health_checking';

    const runner = buildRunner();
    await runner.recoverAfterRestart();

    expect(transitions.map((entry) => entry.to)).toEqual(['succeeded']);
    expect(updateService.recordTaskOutcome).toHaveBeenCalledWith(expect.anything(), 'succeeded');
  });

  it('重启恢复：运行版本等于起始版本 → 已回退终态', async () => {
    taskFixture.status = 'restarting';

    const runner = buildRunner();
    await runner.recoverAfterRestart();

    expect(transitions.map((entry) => entry.to)).toEqual(['rollback_pending', 'rolling_back', 'rolled_back']);
    expect(updateService.recordTaskOutcome).toHaveBeenCalledWith(expect.anything(), 'rolled_back');
  });

  it('重启恢复：运行版本与预期不符时保守挂起，不盲目重跑', async () => {
    versionService.getCurrentVersion.mockReturnValue('0.9.0');
    taskFixture.status = 'activating';

    const runner = buildRunner();
    await runner.recoverAfterRestart();

    expect(transitions).toEqual([]);
    expect(updateService.recordTaskOutcome).not.toHaveBeenCalled();
  });
});
