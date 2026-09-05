// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mount, flushPromises, type VueWrapper } from '@vue/test-utils';
import SystemUpdate from './SystemUpdate.vue';
import * as updateApi from '../../api/update';
import type { UpdateCandidate, UpdateStatusResponse, UpdateTaskSummary } from '../../types/update';

vi.mock('../../api/update', () => ({
  fetchUpdateStatus: vi.fn(),
  checkUpdate: vi.fn(),
  installUpdate: vi.fn(),
  fetchUpdateTasks: vi.fn(),
  fetchUpdateTask: vi.fn(),
  cancelUpdateTask: vi.fn(),
}));

vi.mock('@/utils/message', () => ({
  default: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() },
}));

// TDesign 组件按需 stub：保留渲染与事件，避免 jsdom 下引入完整组件库
vi.mock('tdesign-vue-next', () => {
  const Alert = {
    name: 'TAlert',
    props: ['theme', 'message'],
    template: '<div class="t-alert-stub" :data-theme="theme">{{ message }}</div>',
  };
  const Button = {
    name: 'TButton',
    inheritAttrs: false,
    props: ['loading', 'disabled', 'theme', 'variant', 'content'],
    emits: ['click'],
    template: '<button class="t-button-stub" :disabled="disabled" @click="$emit(\'click\')"><slot /></button>',
  };
  const Tag = {
    name: 'TTag',
    props: ['theme', 'variant'],
    template: '<span class="t-tag-stub" :data-theme="theme"><slot /></span>',
  };
  const Dialog = {
    name: 'TDialog',
    props: ['visible', 'header'],
    emits: ['confirm', 'close'],
    template: '<div v-if="visible" class="t-dialog-stub"><slot /><button class="dialog-confirm" @click="$emit(\'confirm\')">confirm</button></div>',
  };
  const Progress = {
    name: 'TProgress',
    props: ['percentage', 'status'],
    template: '<div class="t-progress-stub" :data-status="status">{{ percentage }}</div>',
  };
  const Tooltip = {
    name: 'TTooltip',
    props: ['content', 'disabled'],
    template: '<span class="t-tooltip-stub"><slot /></span>',
  };
  const Table = {
    name: 'TTable',
    props: ['data', 'columns', 'rowKey'],
    template: '<div class="t-table-stub"><div v-for="row in data" :key="row.taskId" class="table-row" /></div>',
  };
  return { default: { install: () => undefined }, Alert, Button, Tag, Dialog, Progress, Tooltip, Table };
});

function baseStatus(overrides: Partial<UpdateStatusResponse> = {}): UpdateStatusResponse {
  return {
    status: 'up_to_date',
    stale: false,
    currentVersion: '1.0.0',
    checkedAt: '2026-09-04T08:00:00Z',
    lastSuccessfulCheckAt: '2026-09-04T08:00:00Z',
    reason: null,
    reasonText: null,
    candidate: null,
    latestStableVersion: '1.0.0',
    checkEnabled: true,
    installEnabled: true,
    activeTask: null,
    ...overrides,
  };
}

function candidateFixture(): UpdateCandidate {
  return {
    releaseId: 42,
    releaseTag: 'v1.1.0',
    version: '1.1.0',
    channel: 'stable' as const,
    publishedAt: '2026-09-01T00:00:00Z',
    releaseNotes: 'release notes line',
    asset: { name: 'tgtc-v1.1.0-linux-x64.zip', size: 1234, sha256: 'a'.repeat(64) },
    manifest: {
      schemaVersion: 1,
      version: '1.1.0',
      channel: 'stable' as const,
      publishedAt: '2026-09-01T00:00:00Z',
      platform: 'linux' as const,
      arch: 'x64' as const,
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

function activeTaskFixture(overrides: Partial<UpdateTaskSummary> = {}): UpdateTaskSummary {
  return {
    taskId: 'a1b2c3d4-e5f6-4a1b-8c9d-0123456789ab',
    currentVersion: '1.0.0',
    targetVersion: '1.1.0',
    releaseId: 42,
    releaseTag: 'v1.1.0',
    status: 'backing_up',
    progress: 40,
    errorCode: null,
    errorSummary: null,
    rollbackStatus: null,
    startedAt: '2026-09-04T09:00:00Z',
    finishedAt: null,
    requestedBy: 'user-1',
    metadata: null,
    ...overrides,
  };
}

describe('SystemUpdate.vue', () => {
  let wrapper: VueWrapper | null = null;

  const mockedApi = vi.mocked(updateApi, true);

  beforeEach(() => {
    vi.clearAllMocks();
    mockedApi.fetchUpdateTasks.mockResolvedValue([]);
    mockedApi.fetchUpdateStatus.mockResolvedValue(baseStatus());
  });

  afterEach(() => {
    wrapper?.unmount();
    wrapper = null;
  });

  async function mountWith(status: UpdateStatusResponse): Promise<VueWrapper> {
    mockedApi.fetchUpdateStatus.mockResolvedValue(status);
    const w = mount(SystemUpdate);
    await flushPromises();
    return w;
  }

  it('已是最新版：渲染成功横幅且不显示候选卡', async () => {
    wrapper = await mountWith(baseStatus());
    const banners = wrapper.findAll('.t-alert-stub');
    expect(banners.some((banner) => banner.text().includes('当前已是最新稳定版'))).toBe(true);
    expect(wrapper.find('.candidate-card').exists()).toBe(false);
  });

  it('有更新：展示候选信息与发行说明，安装按钮可用', async () => {
    wrapper = await mountWith(baseStatus({
      status: 'update_available',
      latestStableVersion: '1.1.0',
      candidate: candidateFixture(),
    }));

    expect(wrapper.find('.candidate-card').exists()).toBe(true);
    expect(wrapper.text()).toContain('v1.1.0');
    // 发行说明必须以纯文本 pre 渲染（XSS 防线）
    expect(wrapper.find('pre.notes-body').text()).toContain('release notes line');
    const installButton = wrapper.findAll('button.t-button-stub')
      .find((button) => button.text().includes('下载并安装'));
    expect(installButton?.attributes('disabled')).toBeUndefined();
  });

  it('安装入口未开放时按钮禁用且展示原因', async () => {
    wrapper = await mountWith(baseStatus({
      status: 'update_available',
      candidate: candidateFixture(),
      installEnabled: false,
    }));

    const installButton = wrapper.findAll('button.t-button-stub')
      .find((button) => button.text().includes('下载并安装'));
    expect(installButton?.attributes('disabled')).toBeDefined();
  });

  it('候选不兼容时安装按钮禁用', async () => {
    wrapper = await mountWith(baseStatus({
      status: 'update_available',
      candidate: { ...candidateFixture(), compatible: false, compatibilityReason: 'rollback_unsafe' },
    }));

    const installButton = wrapper.findAll('button.t-button-stub')
      .find((button) => button.text().includes('下载并安装'));
    expect(installButton?.attributes('disabled')).toBeDefined();
    expect(wrapper.text()).toContain('不支持安全的程序回退');
  });

  it('stale：横幅提示检查失败并使用缓存结果', async () => {
    wrapper = await mountWith(baseStatus({
      status: 'stale',
      stale: true,
      reason: 'rate_limited',
      lastSuccessfulCheckAt: '2026-09-03T08:00:00Z',
      candidate: candidateFixture(),
    }));

    const banners = wrapper.findAll('.t-alert-stub');
    expect(banners.some((banner) => banner.text().includes('更新源限流') && banner.text().includes('缓存结果'))).toBe(true);
  });

  it('二次确认后调用 installUpdate 并刷新状态', async () => {
    mockedApi.installUpdate.mockResolvedValue(activeTaskFixture());
    wrapper = await mountWith(baseStatus({
      status: 'update_available',
      latestStableVersion: '1.1.0',
      candidate: candidateFixture(),
    }));

    await wrapper.findAll('button.t-button-stub')
      .find((button) => button.text().includes('下载并安装'))!
      .trigger('click');
    await flushPromises();
    expect(wrapper.find('.t-dialog-stub').exists()).toBe(true);

    await wrapper.find('.dialog-confirm').trigger('click');
    await flushPromises();

    expect(mockedApi.installUpdate).toHaveBeenCalledWith(42);
    expect(mockedApi.fetchUpdateStatus).toHaveBeenCalledTimes(2);
  });

  it('活动任务：显示阶段进度，不可取消阶段不提供取消按钮', async () => {
    wrapper = await mountWith(baseStatus({
      activeTask: activeTaskFixture({ status: 'backing_up', progress: 40 }),
    }));

    expect(wrapper.find('.progress-card').exists()).toBe(true);
    expect(wrapper.text()).toContain('数据库备份');
    expect(wrapper.findAll('button.t-button-stub').some((button) => button.text().includes('取消更新'))).toBe(false);
  });

  it('安全阶段（downloading）提供取消按钮并调用 cancelUpdateTask', async () => {
    mockedApi.cancelUpdateTask.mockResolvedValue(activeTaskFixture({ status: 'cancelled' }));
    wrapper = await mountWith(baseStatus({
      activeTask: activeTaskFixture({ status: 'downloading', progress: 5 }),
    }));

    const cancelButton = wrapper.findAll('button.t-button-stub')
      .find((button) => button.text().includes('取消更新'));
    expect(cancelButton).toBeDefined();
    await cancelButton!.trigger('click');
    await flushPromises();
    expect(mockedApi.cancelUpdateTask).toHaveBeenCalledWith('a1b2c3d4-e5f6-4a1b-8c9d-0123456789ab');
  });

  it('后端重启恢复：挂载时从 status 恢复活动任务（不丢任务）', async () => {
    wrapper = await mountWith(baseStatus({
      activeTask: activeTaskFixture({ status: 'health_checking', progress: 90 }),
    }));

    expect(wrapper.text()).toContain('健康检查');
    expect(wrapper.text()).toContain('a1b2c3d4');
  });
});
