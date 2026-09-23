// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mount, flushPromises, type VueWrapper } from '@vue/test-utils';
import * as accountsApi from '@/api/telegram-accounts';
import type {
  AccountPoolOverview,
  MirrorBackfillJob,
  MirrorOverview,
  ReplicationAuditReport,
  TelegramAccountView,
} from '@/api/telegram-accounts';
import TelegramAccounts from './TelegramAccounts.vue';

vi.mock('@/utils/message', () => ({
  default: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() },
}));

// TDesign 组件按需 stub：保留渲染与事件，避免 jsdom 下加载完整组件库。
// 说明：账号视图用 `useMobile` 为 true 走移动端分支，因此无需 stub 真实 t-table 的插槽渲染，
// 直接断言移动端卡片上的操作按钮即可（见测试用例 3）。
vi.mock('tdesign-vue-next', () => {
  const Button = {
    name: 'TButton',
    props: ['loading', 'disabled', 'theme', 'variant'],
    emits: ['click'],
    template: '<button class="t-button-stub" :disabled="disabled || loading" @click="$emit(\'click\')"><slot /></button>',
  };
  const Tag = { name: 'TTag', props: ['theme', 'variant'], template: '<span class="t-tag-stub"><slot /></span>' };
  const Switch = { name: 'TSwitch', props: ['value', 'modelValue'], template: '<span class="t-switch-stub" />' };
  const Alert = { name: 'TAlert', props: ['theme', 'title', 'message'], template: '<div class="t-alert-stub"><slot /></div>' };
  const Tabs = { name: 'TTabs', props: ['modelValue'], emits: ['update:modelValue'], template: '<div class="t-tabs-stub"><slot /></div>' };
  const TabPanel = { name: 'TTabPanel', props: ['value', 'label'], template: '<div class="t-tab-panel-stub"><slot /></div>' };
  const Input = {
    name: 'TInput',
    props: ['modelValue'],
    emits: ['update:modelValue'],
    template: '<input class="t-input-stub" :value="modelValue ?? \'\'" @input="$emit(\'update:modelValue\', $event.target.value)" />',
  };
  // 用真实 <select>/<option> 渲染，便于测试通过 setValue 触发 v-model 与 @change
  const Select = {
    name: 'TSelect',
    props: ['modelValue'],
    emits: ['update:modelValue', 'change'],
    template:
      '<select class="t-select-stub" @change="$emit(\'update:modelValue\', $event.target.value); $emit(\'change\', $event.target.value)"><slot /></select>',
  };
  const Option = { name: 'TOption', props: ['value', 'label'], template: '<option :value="value">{{ label }}</option>' };
  const Table = { name: 'TTable', props: ['data', 'columns'], template: '<div class="t-table-stub" />' };
  const Pagination = { name: 'TPagination', props: ['current', 'total', 'pageSize'], template: '<div class="t-pagination-stub" />' };
  const Dialog = { name: 'TDialog', props: ['visible', 'header'], emits: ['update:visible', 'confirm'], template: '<div />' };
  const RadioGroup = { name: 'TRadioGroup', template: '<div><slot /></div>' };
  const RadioButton = { name: 'TRadioButton', props: ['value'], template: '<label><slot /></label>' };
  const Checkbox = { name: 'TCheckbox', props: ['checked'], template: '<label><slot /></label>' };
  const Tooltip = { name: 'TTooltip', props: ['content'], template: '<span><slot /></span>' };
  const Textarea = { name: 'TTextarea', props: ['modelValue'], template: '<textarea class="t-textarea-stub" />' };
  const InputNumber = { name: 'TInputNumber', props: ['modelValue'], template: '<input class="t-input-number-stub" />' };
  return {
    DialogPlugin: { confirm: vi.fn(), alert: vi.fn(), info: vi.fn(), warning: vi.fn() },
    Button,
    Tag,
    Switch,
    Alert,
    Tabs,
    TabPanel,
    Input,
    Select,
    Option,
    Table,
    Pagination,
    Dialog,
    RadioGroup,
    RadioButton,
    Checkbox,
    Tooltip,
    Textarea,
    InputNumber,
  };
});

// 走移动端分支：直接渲染带操作按钮的账号卡片，无需真实表格插槽
vi.mock('@/composables/useMobile', async () => {
  const { ref } = await import('vue');
  return { useMobile: () => ref(true) };
});

vi.mock('@/api/telegram-accounts', () => ({
  cancelMirrorBackfill: vi.fn(),
  cancelMirrorTask: vi.fn(),
  createBotAccount: vi.fn(),
  createUserAccount: vi.fn(),
  deleteAccount: vi.fn(),
  fetchAccountOverview: vi.fn(),
  fetchMirrorBackfill: vi.fn(),
  fetchAccounts: vi.fn(),
  fetchMirrorOverview: vi.fn(),
  fetchMirrorTasks: vi.fn(),
  fetchReplicationAudit: vi.fn(),
  pauseMirrorBackfill: vi.fn(),
  probeEnvAccount: vi.fn(),
  resumeMirrorBackfill: vi.fn(),
  retryMirrorTask: vi.fn(),
  rotateAccount: vi.fn(),
  setAccountPoolEnabled: vi.fn(),
  startMirrorBackfill: vi.fn(),
  setMirrorEnabled: vi.fn(),
  setMirrorRuleEnabled: vi.fn(),
  startUserAuth: vi.fn(),
  testAccount: vi.fn(),
  testMirrorRule: vi.fn(),
  updateAccount: vi.fn(),
  updateMirrorRule: vi.fn(),
  updateReplicationTarget: vi.fn(),
  verifyUserAuth: vi.fn(),
}));

function overviewFixture(): AccountPoolOverview {
  return {
    feature: {
      accountPoolEnabled: false,
      mirrorEnabled: false,
      accountPoolSource: 'default',
      mirrorSource: 'default',
      accountPoolForceDisabled: false,
      mirrorForceDisabled: false,
    },
    credentialCryptoAvailable: true,
    userClientAvailable: true,
    userClientUnavailableReason: null,
    counts: { total: 0, bot: 0, user: 0, enabled: 0, active: 0, degraded: 0, disabled: 0, revoked: 0, pendingAuth: 0 },
    pool: { enabled: false, inactiveReason: null, primaryAccountId: null, accountCount: 0, envAccountCount: 0 },
    envAccounts: [],
    precheck: [],
  };
}

function mirrorFixture(): MirrorOverview {
  return {
    rule: null,
    test: null,
    tasks: {
      queued: 0,
      running: 0,
      succeeded: 0,
      retrying: 0,
      failed: 0,
      blocked: 0,
      cancelled: 0,
      todaySucceeded: 0,
      todayFailed: 0,
      todayBlocked: 0,
      lastError: null,
    },
    metrics: {
      tasksQueued: 0,
      tasksSucceeded: 0,
      tasksFailed: 0,
      tasksBlocked: 0,
      tasksRetried: 0,
      botUploadBytes: 0,
      botUploadCount: 0,
      userCopyCount: 0,
      fallbackCount: 0,
    },
    feature: { mirrorEnabled: false, source: 'default', forceDisabled: false },
    precheck: [],
    notes: [],
  };
}

function backfillFixture(): MirrorBackfillJob {
  return {
    status: 'idle',
    mode: 'dry-run',
    limit: 0,
    scanned: 0,
    queued: 0,
    skipped: 0,
    sample: [],
    startedAt: null,
    updatedAt: '',
    finishedAt: null,
    lastError: null,
    cursor: null,
  };
}

function replicationFixture(): ReplicationAuditReport {
  return {
    generatedAt: '2026-09-24T00:00:00.000Z',
    target: {
      configured: 2,
      configuredSource: 'system',
      eligibleCount: 2,
      effectiveTarget: 2,
      degradedReason: null,
      allowedRange: { min: 1, max: 8 },
    },
    poolActive: true,
    accounts: [
      {
        accountId: 'a1',
        enabled: true,
        storageConfigured: true,
        coolingDown: false,
        cooldownRemainingMs: 0,
        consecutiveFailures: 0,
        inflight: 0,
        maxInflight: 8,
        readyCopies: 8,
        eligible: true,
        reasons: [],
      },
      {
        accountId: 'a2',
        enabled: true,
        storageConfigured: false,
        coolingDown: false,
        cooldownRemainingMs: 0,
        consecutiveFailures: 0,
        inflight: 0,
        maxInflight: 8,
        readyCopies: 0,
        eligible: false,
        reasons: ['未配置存储 Chat'],
      },
    ],
    coverage: {
      scannedFiles: 10,
      satisfied: 8,
      unsatisfied: 2,
      truncated: false,
      missingSamples: [{ ownerId: 'file-9', readyAccountCount: 0, missing: 2 }],
    },
    capacity: {
      enabled: true,
      currentBudget: 16,
      targetBudget: 16,
      activeBotCount: 2,
      eligibleCount: 2,
      activeBotIds: ['a1', 'a2'],
      suspendedReason: null,
      frozenReason: null,
      pendingUpCycles: 0,
      pendingDownCycles: 0,
      lastChange: null,
    },
    notes: ['USERbot 中继不计入 Bot ready 副本覆盖。'],
  };
}

function accountView(overrides: Partial<TelegramAccountView> = {}): TelegramAccountView {
  return {
    id: 'a1',
    type: 'bot',
    name: '账号',
    externalId: '***1111',
    status: 'active',
    enabled: true,
    weight: 1,
    maxInflight: 8,
    primaryChatId: null,
    capabilities: null,
    credentialConfigured: true,
    credentialVersion: 'v1',
    lastHealthCheckAt: null,
    lastSuccessAt: null,
    lastFailureAt: null,
    lastFailureCode: null,
    lastFailureSummary: null,
    note: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

const mockedApi = vi.mocked(accountsApi, true);

async function settle(wrapper?: VueWrapper) {
  await flushPromises();
  if (wrapper) await wrapper.vm.$nextTick();
  await flushPromises();
}

function mountView(): VueWrapper {
  return mount(TelegramAccounts, {
    global: { stubs: { RouterLink: { template: '<a><slot /></a>' } } },
  });
}

describe('TelegramAccounts.vue 账号状态筛选', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedApi.fetchAccountOverview.mockResolvedValue(overviewFixture());
    mockedApi.fetchMirrorOverview.mockResolvedValue(mirrorFixture());
    mockedApi.fetchMirrorTasks.mockResolvedValue({ items: [], total: 0 });
    mockedApi.fetchMirrorBackfill.mockResolvedValue(backfillFixture());
    mockedApi.fetchAccounts.mockResolvedValue({ items: [], total: 0, envAccounts: [] });
    mockedApi.fetchReplicationAudit.mockResolvedValue(replicationFixture());
  });

  it('默认加载：不带 status，也不打开 includeRevoked（后端默认排除已撤销）', async () => {
    const wrapper = mountView();
    await settle(wrapper);

    const query = mockedApi.fetchAccounts.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(query.type).toBe('bot');
    expect(query.status).toBeUndefined();
    // 关键：默认不传 includeRevoked（既不传 key，也不为 true）
    expect('includeRevoked' in query).toBe(false);
  });

  it('选择「已撤销」：带 status=revoked 重新加载且重置到第 1 页', async () => {
    const wrapper = mountView();
    await settle(wrapper);
    const callsBefore = mockedApi.fetchAccounts.mock.calls.length;

    // 账号状态下拉位于筛选区，DOM 顺序在镜像任务筛选之前 → 取第一个 select
    const statusSelect = wrapper.findAll('select.t-select-stub')[0];
    await statusSelect.setValue('revoked');
    await settle(wrapper);

    const calls = mockedApi.fetchAccounts.mock.calls;
    expect(calls.length).toBeGreaterThan(callsBefore);
    const query = calls[calls.length - 1][0] as Record<string, unknown>;
    expect(query.status).toBe('revoked');
    expect(query.page).toBe(1);
  });

  it('已撤销行不显示「删除」但保留「轮换」；正常行仍可删除', async () => {
    mockedApi.fetchAccounts.mockResolvedValue({
      items: [
        accountView({ id: 'r1', name: '撤销账号', status: 'revoked', enabled: false }),
        accountView({ id: 'a1', name: '正常账号', status: 'active', enabled: true }),
      ],
      total: 2,
      envAccounts: [],
    });
    const wrapper = mountView();
    await settle(wrapper);

    const cards = wrapper.findAll('.mobile-account-card');
    expect(cards).toHaveLength(2);

    const revokedButtons = cards[0].findAll('button.t-button-stub').map((b) => b.text());
    expect(revokedButtons).toContain('轮换');
    expect(revokedButtons).not.toContain('删除');

    const activeButtons = cards[1].findAll('button.t-button-stub').map((b) => b.text());
    expect(activeButtons).toContain('轮换');
    expect(activeButtons).toContain('删除');
  });
});

describe('TelegramAccounts.vue 副本扩散策略', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedApi.fetchAccountOverview.mockResolvedValue(overviewFixture());
    mockedApi.fetchMirrorOverview.mockResolvedValue(mirrorFixture());
    mockedApi.fetchMirrorTasks.mockResolvedValue({ items: [], total: 0 });
    mockedApi.fetchMirrorBackfill.mockResolvedValue(backfillFixture());
    mockedApi.fetchAccounts.mockResolvedValue({ items: [], total: 0, envAccounts: [] });
    mockedApi.fetchReplicationAudit.mockResolvedValue(replicationFixture());
  });

  it('加载审计：展示有效目标、权重预算与覆盖率（含未达标样例）', async () => {
    const wrapper = mountView();
    await settle(wrapper);

    expect(mockedApi.fetchReplicationAudit).toHaveBeenCalledTimes(1);
    const text = wrapper.text();
    expect(text).toContain('副本扩散策略');
    expect(text).toContain('有效目标 2 路');
    expect(text).toContain('可承载账号 2 个');
    expect(text).toContain('8 / 10');
    expect(text).toContain('file-9');
    expect(text).toContain('USERbot');
  });

  it('保存期望副本数：调用热更新接口并重新拉取审计', async () => {
    const wrapper = mountView();
    await settle(wrapper);
    const callsBefore = mockedApi.fetchReplicationAudit.mock.calls.length;
    mockedApi.updateReplicationTarget.mockResolvedValue({
      message: '期望副本数已更新为 2',
      target: replicationFixture().target,
    });

    const saveButton = wrapper
      .findAll('button.t-button-stub')
      .find((button) => button.text().includes('保存期望副本数'));
    expect(saveButton).toBeTruthy();
    await saveButton!.trigger('click');
    await settle(wrapper);

    // 表单初值来自审计结果（configured=2）
    expect(mockedApi.updateReplicationTarget).toHaveBeenCalledWith(2);
    expect(mockedApi.fetchReplicationAudit.mock.calls.length).toBeGreaterThan(callsBefore);
  });

  it('审计加载失败时保留上次数据并提示，不重置表单', async () => {
    const wrapper = mountView();
    await settle(wrapper);
    mockedApi.fetchReplicationAudit.mockRejectedValueOnce(new Error('boom'));

    await wrapper
      .findAll('button.t-button-stub')
      .find((button) => button.text().includes('刷新审计'))!
      .trigger('click');
    await settle(wrapper);

    // 失败不清空既有报告（仍展示上一次的目标与覆盖率）
    expect(wrapper.text()).toContain('有效目标 2 路');
  });
});
