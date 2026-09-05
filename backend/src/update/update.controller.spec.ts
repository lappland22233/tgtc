import 'reflect-metadata';
import { BadRequestException, ConflictException } from '@nestjs/common';
import { Request } from 'express';
import { UpdateController } from './update.controller';
import { UpdateService, UpdateTaskSummary } from './update.service';
import { loadUpdateConfig, UpdateConfig } from './update.config';
import { UpdateCandidate, UpdateCheckResult, UpdateCheckService } from './update-check.service';
import { UpdateTaskService } from './update-task.service';
import { UpdateStateTransitionError } from './update-state-machine';
import { VersionService } from '../version/version.service';
import { AuditService } from '../common/services/audit.service';
import { ROLES_KEY } from '../common/decorators/roles.decorator';
import { User, UserRole } from '../common/entities/user.entity';

const SUPER_ADMIN_USER = {
  id: '00000000-0000-4000-8000-000000000001',
  role: UserRole.SUPER_ADMIN,
} as unknown as User;
const ADMIN_USER = {
  id: '00000000-0000-4000-8000-000000000002',
  role: UserRole.ADMIN,
} as unknown as User;
const REQ = { ip: '127.0.0.1', ips: [] } as unknown as Request;

function baseSummary(overrides: Partial<UpdateTaskSummary> = {}): UpdateTaskSummary {
  return {
    taskId: 'task-1',
    currentVersion: '1.0.0',
    targetVersion: '1.1.0',
    releaseId: 42,
    releaseTag: 'v1.1.0',
    status: 'queued',
    progress: 0,
    errorCode: null,
    errorSummary: null,
    rollbackStatus: null,
    startedAt: new Date().toISOString(),
    finishedAt: null,
    requestedBy: SUPER_ADMIN_USER.id,
    metadata: { assetSha256: 'a'.repeat(64), includesDbMigration: false },
    ...overrides,
  };
}

function compatibleCandidate(): UpdateCandidate {
  return {
    releaseId: 42,
    releaseTag: 'v1.1.0',
    version: '1.1.0',
    channel: 'stable',
    publishedAt: '2026-09-01T00:00:00Z',
    releaseNotes: 'notes',
    asset: { name: 'tgtc-v1.1.0-linux-x64.zip', size: 1234, sha256: 'a'.repeat(64) },
    downloads: {
      assetUrl: 'https://github.com/lappland22233/tgtc/releases/download/v1.1.0/tgtc-v1.1.0-linux-x64.zip',
      sumsUrl: 'https://github.com/lappland22233/tgtc/releases/download/v1.1.0/SHA256SUMS',
      sumsSha256: 'b'.repeat(64),
      sumsSigUrl: 'https://github.com/lappland22233/tgtc/releases/download/v1.1.0/SHA256SUMS.sig',
      manifestUrl: 'https://github.com/lappland22233/tgtc/releases/download/v1.1.0/release-manifest.json',
      manifestSha256: 'c'.repeat(64),
    },
    manifest: {
      schemaVersion: 1,
      version: '1.1.0',
      channel: 'stable',
      publishedAt: '2026-09-01T00:00:00Z',
      platform: 'linux',
      arch: 'x64',
      asset: { name: 'tgtc-v1.1.0-linux-x64.zip', size: 1234, sha256: 'a'.repeat(64) },
      minUpgradableVersion: '0.0.0',
      maxUpgradableVersion: null,
      includesDbMigration: false,
      programRollbackSafe: true,
      healthCheck: { path: '/api/health', timeoutMs: 30000 },
    },
    compatible: true,
    compatibilityReason: null,
  };
}

describe('UpdateController 权限与更新编排', () => {
  const rolesMetadata = Reflect.getMetadata(ROLES_KEY, UpdateController) as UserRole[] | undefined;

  it('控制器类级权限仅允许 super_admin（admin/user 一律 403）', () => {
    expect(rolesMetadata).toEqual([UserRole.SUPER_ADMIN]);
    expect(rolesMetadata).not.toContain(UserRole.ADMIN);
    expect(rolesMetadata).not.toContain(UserRole.USER);
  });

  describe('install 编排', () => {
    let audit: { logAwait: jest.Mock };
    let versionService: { getCurrentVersion: jest.Mock };
    let checkService: { getStatus: jest.Mock; getVerifiedCandidate: jest.Mock; check: jest.Mock };
    let taskService: { findActiveTask: jest.Mock; createTask: jest.Mock; findTask: jest.Mock; listTasks: jest.Mock; cancelTask: jest.Mock };
    let config: UpdateConfig;
    let controller: UpdateController;

    beforeEach(() => {
      jest.clearAllMocks();
      audit = { logAwait: jest.fn().mockResolvedValue(undefined) };
      versionService = { getCurrentVersion: jest.fn(() => '1.0.0') };
      checkService = {
        getStatus: jest.fn(),
        getVerifiedCandidate: jest.fn().mockResolvedValue(compatibleCandidate()),
        check: jest.fn(),
      };
      taskService = {
        findActiveTask: jest.fn().mockResolvedValue(null),
        createTask: jest.fn().mockResolvedValue({ task: { ...baseSummary(), metadata: { assetSha256: 'a'.repeat(64) } } as never }),
        findTask: jest.fn(),
        listTasks: jest.fn().mockResolvedValue([]),
        cancelTask: jest.fn(),
      };
      config = loadUpdateConfig({ UPDATE_INSTALL_ENABLED: 'true' });
      const service = new UpdateService(
        versionService as unknown as VersionService,
        checkService as unknown as UpdateCheckService,
        taskService as unknown as UpdateTaskService,
        config,
        audit as unknown as AuditService,
      );
      controller = new UpdateController(service);
    });

    it('安装功能关闭时返回 400', async () => {
      const disabled = new UpdateService(
        versionService as unknown as VersionService,
        checkService as unknown as UpdateCheckService,
        taskService as unknown as UpdateTaskService,
        loadUpdateConfig({ UPDATE_INSTALL_ENABLED: 'false' }),
        audit as unknown as AuditService,
      );
      const controllerWithDisabled = new UpdateController(disabled);

      await expect(
        controllerWithDisabled.install(SUPER_ADMIN_USER, REQ, { releaseId: 42 }),
      ).rejects.toMatchObject({ status: 400 });
      expect(checkService.getVerifiedCandidate).not.toHaveBeenCalled();
    });

    it('候选二次核验失败时返回 400 脱敏错误', async () => {
      checkService.getVerifiedCandidate.mockRejectedValueOnce(
        Object.assign(new Error('内部细节'), { updateFailureReason: 'release_mismatch' }),
      );

      await expect(
        controller.install(SUPER_ADMIN_USER, REQ, { releaseId: 42 }),
      ).rejects.toMatchObject({ status: 400 });
      expect(taskService.createTask).not.toHaveBeenCalled();
    });

    it('目标版本不高于当前版本（降级/重复安装）返回 400', async () => {
      checkService.getVerifiedCandidate.mockResolvedValueOnce({
        ...compatibleCandidate(),
        version: '1.0.0',
        releaseTag: 'v1.0.0',
      });

      await expect(
        controller.install(SUPER_ADMIN_USER, REQ, { releaseId: 42 }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(taskService.createTask).not.toHaveBeenCalled();
    });

    it('候选不兼容时返回 400', async () => {
      checkService.getVerifiedCandidate.mockResolvedValueOnce({
        ...compatibleCandidate(),
        compatible: false,
        compatibilityReason: 'rollback_unsafe',
      });

      await expect(
        controller.install(SUPER_ADMIN_USER, REQ, { releaseId: 42 }),
      ).rejects.toMatchObject({ status: 400 });
      expect(taskService.createTask).not.toHaveBeenCalled();
    });

    it('并发安装冲突返回 409 与活动任务 ID', async () => {
      taskService.createTask.mockResolvedValueOnce({ conflict: { taskId: 'active-task' } as never });

      const error = await controller
        .install(SUPER_ADMIN_USER, REQ, { releaseId: 42 })
        .catch((caught: unknown) => caught);

      expect(error).toBeInstanceOf(ConflictException);
      expect((error as ConflictException).getResponse()).toMatchObject({ activeTaskId: 'active-task' });
    });

    it('成功创建任务并写入审计；admin 也会被服务层执行（403 由守卫拦截）', async () => {
      const summary = await controller.install(SUPER_ADMIN_USER, REQ, { releaseId: 42 });

      expect(summary.taskId).toBe('task-1');
      expect(summary.metadata).toEqual({ assetSha256: 'a'.repeat(64) });
      expect(audit.logAwait).toHaveBeenCalledWith(expect.objectContaining({
        action: 'update_install',
        userId: SUPER_ADMIN_USER.id,
        ip: '127.0.0.1',
      }));
      // 角色约束由 RolesGuard 在请求前拦截；此处断言守卫元数据不含 admin。
      expect(rolesMetadata).toEqual([UserRole.SUPER_ADMIN]);
      expect((ADMIN_USER as { role: string }).role).toBe('admin');
      expect(rolesMetadata!.includes((ADMIN_USER as unknown as { role: UserRole }).role)).toBe(false);
    });
  });

  describe('cancel 与查询', () => {
    function buildController(
      taskFixture: Record<string, unknown> | null,
      cancelBehavior: 'resolve' | 'reject-transition' = 'resolve',
    ) {
      const audit = { logAwait: jest.fn().mockResolvedValue(undefined) };
      const cancelTask = jest.fn().mockImplementation((task) => {
        if (cancelBehavior === 'reject-transition') {
          return Promise.reject(new UpdateStateTransitionError(task.status, 'cancelled'));
        }
        return Promise.resolve({ ...task, status: 'cancelled', isActive: false });
      });
      const taskService = {
        findActiveTask: jest.fn().mockResolvedValue(null),
        findTask: jest.fn().mockResolvedValue(taskFixture),
        listTasks: jest.fn().mockResolvedValue(taskFixture ? [taskFixture] : []),
        cancelTask,
      };
      const service = new UpdateService(
        { getCurrentVersion: jest.fn(() => '1.0.0') } as unknown as VersionService,
        { getStatus: jest.fn(), check: jest.fn() } as unknown as UpdateCheckService,
        taskService as unknown as UpdateTaskService,
        loadUpdateConfig({ UPDATE_INSTALL_ENABLED: 'true' }),
        audit as unknown as AuditService,
      );
      return { controller: new UpdateController(service), taskService, audit };
    }

    it('任务不存在返回 400', async () => {
      const { controller } = buildController(null);
      await expect(controller.getTask('00000000-0000-4000-8000-00000000dead')).rejects.toBeInstanceOf(BadRequestException);
    });

    it('不可取消阶段返回 409 与当前状态', async () => {
      const { controller } = buildController(
        { taskId: 'task-1', isActive: true, status: 'backing_up', metadata: null },
        'reject-transition',
      );

      const error = await controller
        .cancel(SUPER_ADMIN_USER, REQ, '00000000-0000-4000-8000-000000000001')
        .catch((caught: unknown) => caught);

      expect(error).toBeInstanceOf(ConflictException);
      expect((error as ConflictException).getResponse()).toMatchObject({ status: 'backing_up' });
    });

    it('已终态任务返回 400，不再触发取消', async () => {
      const { controller, taskService } = buildController({
        taskId: 'task-1', isActive: false, status: 'succeeded', metadata: null,
      });

      await expect(
        controller.cancel(SUPER_ADMIN_USER, REQ, '00000000-0000-4000-8000-000000000001'),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(taskService.cancelTask).not.toHaveBeenCalled();
    });

    it('安全阶段取消成功并记录审计', async () => {
      const { controller, audit } = buildController({
        taskId: 'task-1', isActive: true, status: 'downloading', metadata: null, targetVersion: '1.1.0',
      });

      const summary = await controller.cancel(SUPER_ADMIN_USER, REQ, '00000000-0000-4000-8000-000000000001');

      expect(summary.status).toBe('cancelled');
      expect(audit.logAwait).toHaveBeenCalledWith(expect.objectContaining({ action: 'update_cancel' }));
    });

    it('任务摘要不暴露内部路径类元数据', async () => {
      const { controller } = buildController({
        taskId: 'task-1', isActive: true, status: 'queued',
        metadata: { backupDir: '/srv/backup/secret', oldReleaseDir: '/srv/releases/old', assetSha256: 'b'.repeat(64) },
      });

      const summary = await controller.getTask('00000000-0000-4000-8000-000000000001');

      expect(JSON.stringify(summary)).not.toContain('backupDir');
      expect(JSON.stringify(summary)).not.toContain('/srv/');
      expect(summary.metadata).toEqual({ assetSha256: 'b'.repeat(64) });
    });
  });

  describe('status 聚合', () => {
    it('包含检查结果、开关与活动任务摘要', async () => {
      const checkResult: UpdateCheckResult = {
        status: 'up_to_date',
        stale: false,
        currentVersion: '1.0.0',
        checkedAt: new Date().toISOString(),
        lastSuccessfulCheckAt: null,
        reason: null,
        reasonText: null,
        candidate: null,
        latestStableVersion: '1.0.0',
      };
      const audit = { logAwait: jest.fn().mockResolvedValue(undefined) };
      const service = new UpdateService(
        { getCurrentVersion: jest.fn(() => '1.0.0') } as unknown as VersionService,
        {
          getStatus: jest.fn().mockResolvedValue({ ...checkResult, checkEnabled: true, installEnabled: false }),
        } as unknown as UpdateCheckService,
        {
          findActiveTask: jest.fn().mockResolvedValue(null),
        } as unknown as UpdateTaskService,
        loadUpdateConfig({}),
        audit as unknown as AuditService,
      );
      const controller = new UpdateController(service);

      const status = await controller.getStatus();

      expect(status.status).toBe('up_to_date');
      expect(status.checkEnabled).toBe(true);
      expect(status.installEnabled).toBe(false);
      expect(status.activeTask).toBeNull();
    });
  });
});
