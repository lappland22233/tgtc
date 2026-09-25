// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mount, flushPromises, type VueWrapper } from '@vue/test-utils';
import { DialogPlugin } from 'tdesign-vue-next';
import * as accountsApi from '@/api/telegram-accounts';
import type {
  AccountPoolOverview,
  MirrorBackfillJob,
  MirrorOverview,
  MirrorRule,
  MirrorTaskListItem,
  RelayPreflightReport,
  ReplicationAttemptDetailView,
  ReplicationAuditReport,
  TelegramAccountView,
} from '@/api/telegram-accounts';
import MessagePlugin from '@/utils/message';
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
  // 用真实 <button> 渲染并派发 change（取反），用于断言镜像规则的启用开关
  const Switch = {
    name: 'TSwitch',
    props: ['value', 'modelValue', 'loading', 'disabled'],
    emits: ['change'],
    template: '<button class="t-switch-stub" :data-value="String(value)" @click="$emit(\'change\', !value)" />',
  };
  // 渲染 title/message：告警文案（如「观测数据不完整」）必须可被断言
  const Alert = {
    name: 'TAlert',
    props: ['theme', 'title', 'message'],
    template: '<div class="t-alert-stub"><span class="t-alert-title">{{ title }}</span><span class="t-alert-message">{{ message }}</span><slot /></div>',
  };
  const Tabs = { name: 'TTabs', props: ['modelValue'], emits: ['update:modelValue'], template: '<div class="t-tabs-stub"><slot /></div>' };
  const TabPanel = { name: 'TTabPanel', props: ['value', 'label'], template: '<div class="t-tab-panel-stub"><slot /></div>' };
  const Input = {
    name: 'TInput',
    props: ['modelValue', 'name', 'placeholder'],
    emits: ['update:modelValue'],
    template:
      '<input class="t-input-stub" :name="name" :placeholder="placeholder" :value="modelValue ?? \'\'" @input="$emit(\'update:modelValue\', $event.target.value)" />',
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
  RELAY_FAILURE_REASON_LABELS: {
    not_configured: '中继未启用',
    client_unavailable: 'MTProto 客户端不可用',
    no_account: '无可用用户账号',
    source_missing: '源消息不可读',
    target_missing: '目标群未配置',
    permission_denied: '目标群权限不足',
    auth_invalid: '用户账号认证失效',
    rate_limited: 'Telegram 限流',
    network: '网络异常',
    unknown: '未知错误',
  },
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
  fetchReplicationAttemptDetail: vi.fn(),
  fetchReplicationAudit: vi.fn(),
  pauseMirrorBackfill: vi.fn(),
  probeEnvAccount: vi.fn(),
  resumeMirrorBackfill: vi.fn(),
  retryMirrorTask: vi.fn(),
  retryReplicationAttempt: vi.fn(),
  rotateAccount: vi.fn(),
  runRelayPreflight: vi.fn(),
  setAccountPoolEnabled: vi.fn(),
  startMirrorBackfill: vi.fn(),
  setMirrorEnabled: vi.fn(),
  setMirrorRuleEnabled: vi.fn(),
  startUserAuth: vi.fn(),
  testAccount: vi.fn(),
  testMirrorRule: vi.fn(),
  updateAccount: vi.fn(),
  updateMirrorRule: vi.fn(),
  createMirrorRule: vi.fn(),
  deleteMirrorRule: vi.fn(),
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

function mirrorRuleFixture(overrides: Partial<MirrorRule> = {}): MirrorRule {
  return {
    id: 'r1',
    enabled: false,
    name: '镜像群 A',
    sourceChatId: '-1001234567890',
    targetChatId: '-2001234567890',
    preferredAccountId: null,
    includeWebUploads: true,
    includeBotInboundFiles: false,
    lastTestedAt: null,
    lastTestStatus: 'untested',
    lastTestSummary: null,
    createdBy: null,
    updatedBy: null,
    createdAt: '2026-09-24T00:00:00.000Z',
    updatedAt: '2026-09-24T00:00:00.000Z',
    ...overrides,
  };
}

function mirrorFixture(overrides: Partial<MirrorOverview> = {}): MirrorOverview {
  return {
    rules: [],
    rule: null,
    enabledRuleCount: 0,
    mainChatId: null,
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
      userCopyCount: 0,
    },
    feature: { mirrorEnabled: false, source: 'default', forceDisabled: false },
    precheck: [],
    notes: [],
    ...overrides,
  };
}

/** 镜像任务列表项（`mode` 恒为 user_copy，界面不再渲染） */
function taskItem(overrides: Partial<MirrorTaskListItem> = {}): MirrorTaskListItem {
  return {
    id: 't1',
    ruleId: 'r1',
    ownerType: 'file',
    ownerId: 'f1',
    sourceVersion: 1,
    mode: 'user_copy',
    status: 'queued',
    attempts: 0,
    sourceAccountId: null,
    targetAccountId: null,
    targetChatId: null,
    targetMessageId: null,
    fileName: null,
    lastErrorCode: null,
    lastErrorSummary: null,
    nextRetryAt: null,
    startedAt: null,
    completedAt: null,
    createdAt: '2026-09-24T00:00:00.000Z',
    updatedAt: '2026-09-24T00:00:00.000Z',
    ...overrides,
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

function replicationFixture(overrides: Partial<ReplicationAuditReport> = {}): ReplicationAuditReport {
  return {
    generatedAt: '2026-09-24T00:00:00.000Z',
    strategy: {
      mode: 'user_relay_only',
      label: '仅用户账号中继',
      strategyARemoved: true,
      byteReplicationPossible: false,
      relayEnabledByConfig: true,
      restartRequiredForToggle: true,
      capability: {
        relayEnabledByConfig: true,
        userClientAvailable: true,
        userClientUnavailableReason: null,
        enabledAuthorizedUserCount: 2,
        resolvedTargetChatIdPreview: '***7890',
        sourceChatIdPreview: '***1234',
        sourceChatReadable: 'ok',
        targetChatWritable: 'not_checked',
        botsCanReceiveRelay: 'failed',
        checkedAt: '2026-09-24T01:00:00.000Z',
        checkStatus: 'partial',
        notes: ['Bot 可接收中继消息：1 个 Bot 隐私模式未关闭'],
      },
    },
    relayMetrics: {
      windowMs: 86_400_000,
      since: '2026-09-23T00:00:00.000Z',
      attempts: 12,
      relaySucceeded: 9,
      relayFailed: 2,
      blocked: 1,
      succeeded: 6,
      partialSuccess: 2,
      claimTimeouts: 1,
      relaySuccessRate: 0.82,
      claimRate: 0.89,
      relayDurationP50Ms: 1200,
      relayDurationP95Ms: 3400,
      claimDurationP50Ms: 8000,
      claimDurationP95Ms: 15_000,
      failureReasons: [{ reason: 'rate_limited', count: 2 }],
      bytesRelayed: 0,
      sampleSufficient: false,
      truncated: false,
    },
    largeFileCoverage: {
      ownerType: 'fileUnique',
      primary: {
        label: '≥4GiB',
        minBytes: 4 * 1024 ** 3,
        files: 3,
        satisfied: 2,
        unsatisfied: 1,
        readyAccountCounts: [1, 2, 2],
        missingSamples: [{ ownerId: 'uniq-1', readyAccountCount: 1, missing: 1 }],
      },
      secondary: {
        label: '1–4GiB',
        minBytes: 1024 ** 3,
        files: 5,
        satisfied: 5,
        unsatisfied: 0,
        readyAccountCounts: [2, 2, 2, 2, 2],
        missingSamples: [],
      },
      scannedFiles: 8,
      truncated: false,
      readyAccounts: 1,
      schedulableAccounts: 2,
    },
    recentAttempts: [
      {
        id: 'att-1',
        ownerType: 'fileUnique',
        ownerLabel: 'uniq-1…',
        status: 'claim_timeout',
        statusLabel: '认领超时',
        failureReason: 'rate_limited',
        failureReasonLabel: 'Telegram 限流',
        failureSummary: '中继成功但窗口内无 Bot 认领',
        retryCount: 1,
        desiredCount: 2,
        baselineReadyCount: 1,
        readyCount: 1,
        missingCount: 1,
        claimedAccountIds: [],
        relayAccountId: 'u1',
        targetChatPreview: '***7890',
        triggeredBy: 'lazy',
        createdAt: '2026-09-24T02:00:00.000Z',
        relayCompletedAt: '2026-09-24T02:00:02.000Z',
        completedAt: '2026-09-24T02:01:02.000Z',
        nextRetryAt: '2026-09-24T02:01:32.000Z',
        relayDurationMs: 2000,
        claimDurationMs: 60_000,
        retryable: true,
      },
    ],
    observability: { degraded: false, reason: null, since: null, writeFailures: 0 },
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
    ...overrides,
  };
}

function preflightFixture(): RelayPreflightReport {
  return {
    dryRun: true,
    checkedAt: '2026-09-24T03:00:00.000Z',
    status: 'partial',
    checks: [
      { id: 'config', label: '中继开关', status: 'ok', detail: 'TELEGRAM_USER_RELAY_ENABLED=true' },
      {
        id: 'target_chat_writable',
        label: '目标群可写',
        status: 'not_checked',
        detail: 'dry-run 未发送测试消息，无法验证可写性',
        advice: '需要验证时以 dryRun=false 重新探测',
      },
    ],
    sentTestMessage: false,
    testMessageId: null,
    targetChatPreview: '***7890',
    sourceChatPreview: '***1234',
    notes: ['目标群可写：dry-run 未发送测试消息，无法验证可写性'],
  };
}

function attemptDetailFixture(): ReplicationAttemptDetailView {
  return {
    id: 'att-1',
    ownerType: 'fileUnique',
    ownerLabel: 'uniq-1…',
    status: 'claim_timeout',
    statusLabel: '认领超时',
    failureReason: 'rate_limited',
    failureSummary: '中继成功但窗口内无 Bot 认领',
    retryCount: 1,
    desiredCount: 2,
    baselineReadyCount: 1,
    readyCount: 1,
    missingCount: 1,
    claimedAccountIds: [],
    relayAccountId: 'u1',
    relayMessageId: null,
    targetChatPreview: '***7890',
    triggeredBy: 'lazy',
    startedAt: '2026-09-24T02:00:00.000Z',
    relayCompletedAt: '2026-09-24T02:00:02.000Z',
    claimDeadlineAt: '2026-09-24T02:01:02.000Z',
    completedAt: '2026-09-24T02:01:02.000Z',
    nextRetryAt: '2026-09-24T02:01:32.000Z',
    createdAt: '2026-09-24T02:00:00.000Z',
    updatedAt: '2026-09-24T02:01:02.000Z',
    retryable: true,
    timeline: [
      { at: '2026-09-24T02:00:00.000Z', label: '轮次开始' },
      { at: '2026-09-24T02:00:02.000Z', label: '中继完成', detail: '已由用户账号转发到目标群' },
      { at: '2026-09-24T02:01:02.000Z', label: '认领超时', detail: '窗口内没有 Bot 登记 ready 副本' },
    ],
    why: '中继转发成功，但认领窗口内没有 Bot 登记 ready 副本。',
    impact: '该文件在 Bot 直链上仍只有 1 路副本，分流能力不足。',
    advice: '检查目标群内 Bot 的隐私模式与成员状态，确认 Bot 能收到用户账号发出的群消息。',
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
    // 同时标记数据过期，避免把上次数据当成当前健康态
    expect(wrapper.text()).toContain('数据已过期');
  });

  it('策略卡：声明仅用户账号中继、区分探测三态并给出阻塞建议', async () => {
    const wrapper = mountView();
    await settle(wrapper);

    const text = wrapper.text();
    expect(text).toContain('当前策略：仅用户账号中继');
    expect(text).toContain('策略 A（Bot 重新上传到备份群）已移除');
    expect(text).toContain('构造期读取，变更后需重启后端');
    // 三态必须可区分：通过 / 未检查 / 失败
    expect(text).toContain('源群可读：通过');
    expect(text).toContain('目标群可写：未检查');
    expect(text).toContain('Bot 可接收中继消息：失败');
    expect(text).toContain('隐私模式未关闭');
  });

  it('策略卡：链路为「主群 → userbot 中继 → 镜像群 → Bot 认领」，字节二次传输恒为 0', async () => {
    const wrapper = mountView();
    await settle(wrapper);

    const text = wrapper.text();
    expect(text).toContain('主群 → userbot 中继 → 镜像群 → Bot 认领');
    expect(text).toContain('字节二次传输恒为 0');
    // 旧口径文案必须消失（userbot「服务端转发」的旧描述不再作为主链路表述）
    expect(text).not.toContain('userbot 服务端转发');
  });

  it('期望副本数明确标注为审计口径，不再驱动扩散', async () => {
    const wrapper = mountView();
    await settle(wrapper);

    const text = wrapper.text();
    expect(text).toContain('期望副本数（审计口径）');
    expect(text).toContain('TELEGRAM_POOL_TARGET_REPLICAS');
    expect(text).toContain('仅为审计口径');
    expect(text).toContain('扩散由「启用中的镜像规则数」驱动');
    expect(text).toContain('不再作为触发扩散的依据');
  });

  it('指标卡：低样本显示「样本不足」而不是伪造比率，并固定展示零字节契约', async () => {
    const wrapper = mountView();
    await settle(wrapper);

    const text = wrapper.text();
    expect(text).toContain('中继指标（近 24 小时）');
    expect(text).toContain('成功率 样本不足');
    expect(text).toContain('认领率 样本不足');
    expect(text).toContain('中继耗时 P50 1.2s');
    expect(text).toContain('Telegram 限流');
    expect(text).toContain('二次传输字节数恒为 0');
  });

  it('大文件覆盖率：优先展示 ≥4GiB 分层并区分「已登记」与「可调度」', async () => {
    const wrapper = mountView();
    await settle(wrapper);

    const text = wrapper.text();
    expect(text).toContain('≥4GiB');
    expect(text).toContain('1–4GiB');
    expect(text).toContain('2 / 3');
    expect(text).toContain('uniq-1：现有 1 路，缺 1 路');
    expect(text).toContain('副本已登记账号 1 个');
    expect(text).toContain('当前可调度账号 2 个');
  });

  it('只读预检：调用 dryRun=true 并显式声明未产生 Telegram 消息', async () => {
    mockedApi.runRelayPreflight.mockResolvedValue(preflightFixture());
    const wrapper = mountView();
    await settle(wrapper);

    const button = wrapper
      .findAll('button.t-button-stub')
      .find((item) => item.text().includes('能力预检（只读）'));
    expect(button).toBeTruthy();
    await button!.trigger('click');
    await settle(wrapper);

    expect(mockedApi.runRelayPreflight).toHaveBeenCalledWith({ dryRun: true });
    const text = wrapper.text();
    expect(text).toContain('未产生任何 Telegram 消息');
    expect(text).toContain('预检部分通过');
    expect(text).toContain('目标群可写');
  });

  it('事件时间线：展开失败详情展示四段式与生命周期时间线', async () => {
    mockedApi.fetchReplicationAttemptDetail.mockResolvedValue(attemptDetailFixture());
    const wrapper = mountView();
    await settle(wrapper);

    const detailButton = wrapper
      .findAll('button.t-button-stub')
      .find((item) => item.text().includes('失败详情'));
    expect(detailButton).toBeTruthy();
    await detailButton!.trigger('click');
    await settle(wrapper);

    expect(mockedApi.fetchReplicationAttemptDetail).toHaveBeenCalledWith('att-1');
    const text = wrapper.text();
    expect(text).toContain('为什么失败');
    expect(text).toContain('影响');
    expect(text).toContain('建议操作');
    expect(text).toContain('是否可重试');
    expect(text).toContain('窗口内没有 Bot 登记 ready 副本');
    expect(text).toContain('中继完成');
  });

  it('手动重试：二次确认后只调用中继重试接口并刷新审计', async () => {
    mockedApi.retryReplicationAttempt.mockResolvedValue({
      message: '已重新排队：重置 2 条任务、补建 1 条任务',
      attemptId: 'att-1',
      requeued: 2,
      created: 1,
      ruleIds: ['r1'],
    });
    const confirmMock = vi.mocked(DialogPlugin.confirm);
    confirmMock.mockImplementationOnce((options) => {
      const instance = { destroy: vi.fn() } as unknown as never;
      // 模拟用户点击「确认」：异步触发，保证组件内的 dialog 引用已完成赋值
      Promise.resolve().then(() => options?.onConfirm?.({ e: new MouseEvent('click') }));
      return instance;
    });

    const wrapper = mountView();
    await settle(wrapper);
    const callsBefore = mockedApi.fetchReplicationAudit.mock.calls.length;

    const retryButton = wrapper
      .findAll('button.t-button-stub')
      .find((item) => item.text() === '重试');
    expect(retryButton).toBeTruthy();
    await retryButton!.trigger('click');
    await settle(wrapper);
    await settle(wrapper);

    expect(mockedApi.retryReplicationAttempt).toHaveBeenCalledWith('att-1');
    expect(mockedApi.fetchReplicationAudit.mock.calls.length).toBeGreaterThan(callsBefore);
    // 如实展示后端计数口径
    const text = wrapper.text();
    expect(text).toContain('重排任务 2 条');
    expect(text).toContain('补建任务 1 条');
    expect(text).toContain('影响镜像规则 1 条');
  });

  it('手动重试 0 重排：显示「无需重试」而非成功，且不写成功提示', async () => {
    mockedApi.retryReplicationAttempt.mockResolvedValue({
      message: '该文件在当前镜像群上已有在途任务，无需重试（可直接观察任务状态）',
      attemptId: 'att-1',
      requeued: 0,
      created: 0,
      ruleIds: [],
    });
    const confirmMock = vi.mocked(DialogPlugin.confirm);
    confirmMock.mockImplementationOnce((options) => {
      const instance = { destroy: vi.fn() } as unknown as never;
      Promise.resolve().then(() => options?.onConfirm?.({ e: new MouseEvent('click') }));
      return instance;
    });

    const wrapper = mountView();
    await settle(wrapper);

    await wrapper
      .findAll('button.t-button-stub')
      .find((item) => item.text() === '重试')!
      .trigger('click');
    await settle(wrapper);
    await settle(wrapper);

    const text = wrapper.text();
    expect(text).toContain('无需重试');
    expect(text).toContain('重排任务 0 条');
    expect(text).toContain('补建任务 0 条');
    expect(text).toContain('未产生任何新的排队或补建');
    // 关键：0 重排不得给出成功提示（不粉饰）
    expect(vi.mocked(MessagePlugin.success)).not.toHaveBeenCalled();
    expect(vi.mocked(MessagePlugin.warning)).toHaveBeenCalled();
  });

  it('不可重试的轮次不显示「重试」入口（配置类阻塞需先修正配置）', async () => {
    const blocked = replicationFixture().recentAttempts[0];
    mockedApi.fetchReplicationAudit.mockResolvedValue(replicationFixture({
      recentAttempts: [
        {
          ...blocked,
          id: 'att-blocked',
          status: 'blocked_target_chat',
          statusLabel: '阻塞：目标群不可用',
          failureReason: 'target_missing',
          failureReasonLabel: '目标群未配置',
          retryable: false,
        },
      ],
    }));
    const wrapper = mountView();
    await settle(wrapper);

    const text = wrapper.text();
    expect(text).toContain('阻塞：目标群不可用');
    expect(text).toContain('目标群未配置');
    expect(wrapper.findAll('button.t-button-stub').some((item) => item.text() === '重试')).toBe(false);
  });

  it('观测降级：显式提示「观测数据不完整」，不渲染健康态', async () => {
    mockedApi.fetchReplicationAudit.mockResolvedValue(replicationFixture({
      observability: {
        degraded: true,
        reason: '轮次写入失败 3 次',
        since: '2026-09-24T02:00:00.000Z',
        writeFailures: 3,
      },
    }));
    const wrapper = mountView();
    await settle(wrapper);

    const text = wrapper.text();
    expect(text).toContain('观测数据不完整');
    expect(text).toContain('轮次写入失败 3 次');
  });
});

describe('TelegramAccounts.vue 镜像规则（多规则）', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedApi.fetchAccountOverview.mockResolvedValue(overviewFixture());
    mockedApi.fetchMirrorOverview.mockResolvedValue(mirrorFixture());
    mockedApi.fetchMirrorTasks.mockResolvedValue({ items: [], total: 0 });
    mockedApi.fetchMirrorBackfill.mockResolvedValue(backfillFixture());
    mockedApi.fetchAccounts.mockResolvedValue({ items: [], total: 0, envAccounts: [] });
    mockedApi.fetchReplicationAudit.mockResolvedValue(replicationFixture());
  });

  function findButton(wrapper: VueWrapper, text: string) {
    return wrapper.findAll('button.t-button-stub').find((button) => button.text() === text);
  }

  it('多规则列表：渲染名称、主群/镜像群、启用状态与权限测试结论', async () => {
    mockedApi.fetchMirrorOverview.mockResolvedValue(
      mirrorFixture({
        rules: [
          mirrorRuleFixture({ id: 'r1', name: '镜像群 A', enabled: true, lastTestStatus: 'ok' }),
          mirrorRuleFixture({ id: 'r2', name: '镜像群 B', targetChatId: '-2009999999999', lastTestStatus: 'failed' }),
        ],
        enabledRuleCount: 1,
        mainChatId: '-1001234567890',
      }),
    );
    const wrapper = mountView();
    await settle(wrapper);

    expect(wrapper.findAll('.mirror-rule-row')).toHaveLength(2);
    const text = wrapper.text();
    expect(text).toContain('当前主群：-1001234567890');
    expect(text).toContain('镜像群 A');
    expect(text).toContain('镜像群 B');
    expect(text).toContain('主群（源群，副本扩散中转落点）：');
    expect(text).toContain('-2009999999999');
    expect(text).toContain('已启用');
    expect(text).toContain('权限测试：通过');
    expect(text).toContain('权限测试：失败');
  });

  it('新建规则：调用 createMirrorRule 且载荷不含已删除的 mode/fallbackMode', async () => {
    mockedApi.createMirrorRule.mockResolvedValue({ message: '已创建', rule: mirrorRuleFixture() });
    const wrapper = mountView();
    await settle(wrapper);

    await wrapper.find('input[name="mirror-name"]').setValue('新镜像群');
    await wrapper.find('input[name="mirror-source"]').setValue('-1001234567890');
    await wrapper.find('input[name="mirror-target"]').setValue('-2001234567890');
    await findButton(wrapper, '保存规则')!.trigger('click');
    await settle(wrapper);

    expect(mockedApi.createMirrorRule).toHaveBeenCalledTimes(1);
    const payload = mockedApi.createMirrorRule.mock.calls[0][0] as Record<string, unknown>;
    expect(payload).toMatchObject({
      name: '新镜像群',
      sourceChatId: '-1001234567890',
      targetChatId: '-2001234567890',
    });
    expect('mode' in payload).toBe(false);
    expect('fallbackMode' in payload).toBe(false);
    // 新建走 create，不应误触发更新
    expect(mockedApi.updateMirrorRule).not.toHaveBeenCalled();
  });

  it('编辑规则：回填表单后用带 id 的更新接口提交，且不带 mode', async () => {
    mockedApi.fetchMirrorOverview.mockResolvedValue(
      mirrorFixture({
        rules: [mirrorRuleFixture({ id: 'r1', name: '旧名', lastTestStatus: 'ok' })],
        enabledRuleCount: 0,
        mainChatId: '-1001234567890',
      }),
    );
    mockedApi.updateMirrorRule.mockResolvedValue({ message: '已更新', rule: mirrorRuleFixture() });
    const wrapper = mountView();
    await settle(wrapper);

    await findButton(wrapper, '编辑')!.trigger('click');
    await settle(wrapper);
    const nameInput = wrapper.find('input[name="mirror-name"]').element as HTMLInputElement;
    expect(nameInput.value).toBe('旧名');

    await wrapper.find('input[name="mirror-target"]').setValue('-2007777777777');
    await findButton(wrapper, '保存规则')!.trigger('click');
    await settle(wrapper);

    expect(mockedApi.updateMirrorRule).toHaveBeenCalledWith(
      'r1',
      expect.objectContaining({ targetChatId: '-2007777777777' }),
    );
    const payload = mockedApi.updateMirrorRule.mock.calls[0][1] as Record<string, unknown>;
    expect('mode' in payload).toBe(false);
    expect('fallbackMode' in payload).toBe(false);
    expect(mockedApi.createMirrorRule).not.toHaveBeenCalled();
  });

  it('启用前必须先通过权限测试：前端提示且不调用启用接口', async () => {
    mockedApi.fetchMirrorOverview.mockResolvedValue(
      mirrorFixture({
        rules: [mirrorRuleFixture({ id: 'r1', lastTestStatus: 'untested' })],
        enabledRuleCount: 0,
        mainChatId: '-1001234567890',
      }),
    );
    const wrapper = mountView();
    await settle(wrapper);

    await wrapper.find('.mirror-rule-row button.t-switch-stub').trigger('click');
    await settle(wrapper);

    expect(vi.mocked(MessagePlugin.warning)).toHaveBeenCalled();
    expect(mockedApi.setMirrorRuleEnabled).not.toHaveBeenCalled();
  });

  it('权限测试通过后启用：开关切换调用带 id 的启用接口', async () => {
    mockedApi.fetchMirrorOverview.mockResolvedValue(
      mirrorFixture({
        rules: [mirrorRuleFixture({ id: 'r1', lastTestStatus: 'ok' })],
        enabledRuleCount: 0,
        mainChatId: '-1001234567890',
      }),
    );
    mockedApi.setMirrorRuleEnabled.mockResolvedValue({
      message: '镜像规则已启用',
      rule: mirrorRuleFixture({ enabled: true, lastTestStatus: 'ok' }),
    });
    const wrapper = mountView();
    await settle(wrapper);

    // 页面顶部还有账号池 / 镜像功能两个开关，必须限定在规则行内取开关
    const toggle = wrapper.find('.mirror-rule-row button.t-switch-stub');
    expect(toggle.exists()).toBe(true);
    await toggle.trigger('click');
    await settle(wrapper);

    expect(mockedApi.setMirrorRuleEnabled).toHaveBeenCalledWith('r1', true);
  });

  it('已启用规则：开关切换走停用接口（多规则各自独立启停，无「只允许一条」限制）', async () => {
    mockedApi.fetchMirrorOverview.mockResolvedValue(
      mirrorFixture({
        rules: [
          mirrorRuleFixture({ id: 'r1', name: '群 A', enabled: true, lastTestStatus: 'ok' }),
          mirrorRuleFixture({ id: 'r2', name: '群 B', enabled: true, lastTestStatus: 'ok', targetChatId: '-200999' }),
        ],
        enabledRuleCount: 2,
        mainChatId: '-1001234567890',
      }),
    );
    mockedApi.setMirrorRuleEnabled.mockResolvedValue({
      message: '镜像规则已停用',
      rule: mirrorRuleFixture({ id: 'r1', enabled: false, lastTestStatus: 'ok' }),
    });
    const wrapper = mountView();
    await settle(wrapper);

    expect(wrapper.findAll('.mirror-rule-row')).toHaveLength(2);
    const switches = wrapper.findAll('.mirror-rule-row button.t-switch-stub');
    expect(switches).toHaveLength(2);
    await switches[0].trigger('click');
    await settle(wrapper);

    expect(mockedApi.setMirrorRuleEnabled).toHaveBeenCalledWith('r1', false);
  });

  it('镜像规则区不存在「上传模式 / 降级策略」控件与「只允许一条启用」提示', async () => {
    mockedApi.fetchMirrorOverview.mockResolvedValue(
      mirrorFixture({
        rules: [mirrorRuleFixture({ id: 'r1', lastTestStatus: 'ok' })],
        enabledRuleCount: 0,
        mainChatId: '-1001234567890',
      }),
    );
    const wrapper = mountView();
    await settle(wrapper);

    const text = wrapper.text();
    expect(text).not.toContain('上传模式');
    expect(text).not.toContain('降级策略');
    expect(text).not.toContain('备选模式');
    expect(text).not.toContain('只允许一条启用');
    // 页面不得出现单选/模式选择控件
    expect(wrapper.findAll('.t-radio-group-stub')).toHaveLength(0);
  });

  it('权限测试：按规则调用 testMirrorRule 并展示主群/镜像群明细', async () => {
    mockedApi.fetchMirrorOverview.mockResolvedValue(
      mirrorFixture({
        rules: [mirrorRuleFixture({ id: 'r1', lastTestStatus: 'untested' })],
        enabledRuleCount: 0,
        mainChatId: '-1001234567890',
      }),
    );
    mockedApi.testMirrorRule.mockResolvedValue({
      status: 'ok',
      summary: '主群/镜像群均可达',
      details: [{ chat: 'source', ok: true, title: '主群标题', type: 'supergroup' }],
    });
    const wrapper = mountView();
    await settle(wrapper);

    await findButton(wrapper, '测试权限')!.trigger('click');
    await settle(wrapper);

    expect(mockedApi.testMirrorRule).toHaveBeenCalledWith('r1');
    const text = wrapper.text();
    expect(text).toContain('主群标题');
    expect(text).toContain('主群');
  });

  it('删除规则：二次确认后调用删除接口', async () => {
    mockedApi.fetchMirrorOverview.mockResolvedValue(
      mirrorFixture({
        rules: [mirrorRuleFixture({ id: 'r1' })],
        enabledRuleCount: 0,
        mainChatId: '-1001234567890',
      }),
    );
    mockedApi.deleteMirrorRule.mockResolvedValue({ message: '镜像规则已删除' });
    const confirmMock = vi.mocked(DialogPlugin.confirm);
    confirmMock.mockImplementationOnce((options) => {
      const instance = { destroy: vi.fn() } as unknown as never;
      Promise.resolve().then(() => options?.onConfirm?.({ e: new MouseEvent('click') }));
      return instance;
    });

    const wrapper = mountView();
    await settle(wrapper);
    await findButton(wrapper, '删除')!.trigger('click');
    await settle(wrapper);
    await settle(wrapper);

    expect(mockedApi.deleteMirrorRule).toHaveBeenCalledWith('r1');
  });

  it('删除规则被拒（启用中/有在途任务）：展示后端可读错误', async () => {
    mockedApi.fetchMirrorOverview.mockResolvedValue(
      mirrorFixture({
        rules: [mirrorRuleFixture({ id: 'r1', enabled: true, lastTestStatus: 'ok' })],
        enabledRuleCount: 1,
        mainChatId: '-1001234567890',
      }),
    );
    mockedApi.deleteMirrorRule.mockRejectedValueOnce(
      new Error('该规则还有 2 个在途任务（排队/执行中/重试中），请等待收尾后再删除'),
    );
    const confirmMock = vi.mocked(DialogPlugin.confirm);
    confirmMock.mockImplementationOnce((options) => {
      const instance = { destroy: vi.fn() } as unknown as never;
      Promise.resolve().then(() => options?.onConfirm?.({ e: new MouseEvent('click') }));
      return instance;
    });

    const wrapper = mountView();
    await settle(wrapper);
    await findButton(wrapper, '删除')!.trigger('click');
    await settle(wrapper);
    await settle(wrapper);

    expect(mockedApi.deleteMirrorRule).toHaveBeenCalledWith('r1');
    expect(vi.mocked(MessagePlugin.error)).toHaveBeenCalled();
  });

  it('任务列表：按镜像群（targetChatId）分组，多群失败原因不混成一锅', async () => {
    mockedApi.fetchMirrorOverview.mockResolvedValue(
      mirrorFixture({
        rules: [
          mirrorRuleFixture({ id: 'r1', name: '群 A', enabled: true, targetChatId: '-200111', lastTestStatus: 'ok' }),
          mirrorRuleFixture({ id: 'r2', name: '群 B', enabled: true, targetChatId: '-200222', lastTestStatus: 'ok' }),
        ],
        enabledRuleCount: 2,
        mainChatId: '-1001234567890',
      }),
    );
    mockedApi.fetchMirrorTasks.mockResolvedValue({
      items: [
        taskItem({ id: 't1', ruleId: 'r1', ownerId: 'f1', targetChatId: '-200111', status: 'failed', lastErrorCode: 'flood_wait', lastErrorSummary: 'A 群限流', attempts: 2 }),
        taskItem({ id: 't2', ruleId: 'r2', ownerId: 'f2', targetChatId: '-200222', status: 'blocked', lastErrorCode: 'chat_not_found', lastErrorSummary: 'B 群不可达' }),
        taskItem({ id: 't3', ruleId: 'r1', ownerId: 'f3', targetChatId: '-200111', status: 'queued' }),
      ],
      total: 3,
    });
    const wrapper = mountView();
    await settle(wrapper);

    const groups = wrapper.findAll('.task-group');
    expect(groups).toHaveLength(2);
    // 有问题的群排在前面：A 群（1 失败）→ 实际排序按 失败+阻塞 降序，A=1、B=1 同分 → 按 chatId 升序 → -200111 在前
    const text = wrapper.text();
    expect(text).toContain('镜像群：-200111');
    expect(text).toContain('镜像群：-200222');
    expect(text).toContain('最近失败原因：A 群限流');
    expect(text).toContain('最近失败原因：B 群不可达');
    // 分组标题给出各组独立计数
    expect(text).toContain('失败 1 · 阻塞 0 · 进行中 1');
    expect(text).toContain('失败 0 · 阻塞 1 · 进行中 0');
  });

  it('任务列表：无目标群归属的历史任务单独成组并显式标注', async () => {
    mockedApi.fetchMirrorTasks.mockResolvedValue({
      items: [taskItem({ id: 't9', ruleId: 'r1', ownerId: 'f9', targetChatId: null, status: 'failed', lastErrorSummary: '历史行无群归属' })],
      total: 1,
    });
    const wrapper = mountView();
    await settle(wrapper);

    expect(wrapper.findAll('.task-group')).toHaveLength(1);
    const text = wrapper.text();
    expect(text).toContain('未归属（历史任务）');
    expect(text).toContain('历史行无群归属');
  });

  it('任务列表：空列表给出空状态提示，不渲染分组容器', async () => {
    const wrapper = mountView();
    await settle(wrapper);

    expect(wrapper.findAll('.task-group')).toHaveLength(0);
    expect(wrapper.text()).toContain('暂无镜像任务');
  });

  it('任务列表不再渲染「执行方式」列与旧模式文案', async () => {
    mockedApi.fetchMirrorTasks.mockResolvedValue({
      items: [taskItem({ id: 't1', ruleId: 'r1', ownerId: 'f1', targetChatId: '-200111', status: 'failed' })],
      total: 1,
    });
    const wrapper = mountView();
    await settle(wrapper);

    const text = wrapper.text();
    expect(text).not.toContain('执行方式');
    expect(text).not.toContain('中继（历史行）');
    expect(text).not.toContain('Bot 上传');
  });
});
