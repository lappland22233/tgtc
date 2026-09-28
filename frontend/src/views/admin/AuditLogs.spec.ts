// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';

vi.mock('../../api/client', () => ({
  default: { get: vi.fn() },
}));

vi.mock('@/utils/message', () => ({
  default: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() },
}));

vi.mock('../../composables/useMobile', async () => {
  const { ref } = await import('vue');
  return { useMobile: () => ref(false) };
});

// t-* 组件经 unplugin-vue-components 自动导入为 tdesign-vue-next 具名导出，
// 故 stub 必须放在该 mock 内；Table 按列名渲染具名插槽、Select/Option 渲染 label 文本，
// 以便断言单元格与下拉选项的可见文案。
vi.mock('tdesign-vue-next', () => ({
  RadioGroup: { template: '<div><slot /></div>' },
  RadioButton: { template: '<label><slot /></label>' },
  Select: { props: ['modelValue'], template: '<div class="t-select-stub"><slot /></div>' },
  Option: { props: ['value', 'label'], template: '<div class="t-option-stub">{{ label }}</div>' },
  Input: { props: ['modelValue'], template: '<input class="t-input-stub" />' },
  Button: { props: ['disabled'], template: '<button class="t-button-stub"><slot /></button>' },
  Tag: { props: ['theme'], template: '<span class="t-tag-stub" :data-theme="theme"><slot /></span>' },
  Table: {
    props: ['data', 'columns'],
    template: `
      <table class="t-table-stub">
        <tr v-for="(row, rowIndex) in (data || [])" :key="rowIndex">
          <td v-for="column in (columns || [])" :key="column.colKey">
            <slot :name="column.colKey" :row="row" :rowIndex="rowIndex" />
          </td>
        </tr>
      </table>`,
  },
  Loading: { template: '<div><slot /></div>' },
  Pagination: { template: '<div class="t-pagination-stub" />' },
}));

import apiClient from '../../api/client';
import AuditLogs, {
  actionLabels,
  actionLabel,
  resourceTypeLabel,
  actionTheme,
} from './AuditLogs.vue';

/** v1.5.3 新增的 19 个审计动作（账号池 10 + 镜像备份 9）。 */
const V153_ACTIONS = [
  'telegram_account_created',
  'telegram_account_updated',
  'telegram_account_enabled',
  'telegram_account_disabled',
  'telegram_account_deleted',
  'telegram_account_credential_rotated',
  'telegram_account_tested',
  'telegram_account_auth_started',
  'telegram_account_auth_succeeded',
  'telegram_account_auth_failed',
  'telegram_mirror_feature_enabled',
  'telegram_mirror_feature_disabled',
  'telegram_mirror_config_changed',
  'telegram_mirror_rule_tested',
  'telegram_mirror_task_retried',
  'telegram_mirror_task_cancelled',
  'telegram_mirror_fallback_applied',
  'telegram_mirror_backfill_started',
  'telegram_mirror_backfill_resumed',
];

/** 附带项：后端已写入但联合类型/前端曾缺失的 api_key_rotate。 */
const NEW_ACTIONS = [...V153_ACTIONS, 'api_key_rotate'];

/** v1.5.3 新引入且前端 resourceTypeLabel 缺失的资源类型（后端 grep 核实）。 */
const V153_RESOURCE_TYPES = [
  'telegram_account',
  'telegram_account_pool',
  'telegram_mirror_rule',
  'telegram_mirror_task',
  'telegram_mirror_feature',
  'telegram_mirror_backfill',
];

function mockLogsResponse(url: string) {
  if (url.includes('email-verification-stats')) {
    return Promise.resolve({
      data: { data: { total: 0, success: 0, failure: 0, unknown: 0, successRate: 0, result: 'none' } },
    });
  }
  const items = [
    ...NEW_ACTIONS.map((action, i) => ({
      id: `a${i}`,
      action,
      userId: null,
      username: 'admin',
      ip: '127.0.0.1',
      resourceType: action.startsWith('telegram_account_') ? 'telegram_account' : 'telegram_mirror_task',
      resourceId: 'r1',
      metadata: null,
      status: 'success',
      createdAt: '2026-01-01T00:00:00.000Z',
    })),
    ...V153_RESOURCE_TYPES.map((type, i) => ({
      id: `t${i}`,
      action: 'config_change',
      userId: null,
      username: 'admin',
      ip: '127.0.0.1',
      resourceType: type,
      resourceId: 'r2',
      metadata: null,
      status: 'success',
      createdAt: '2026-01-01T00:00:00.000Z',
    })),
  ];
  return Promise.resolve({ data: { data: { items, total: items.length } } });
}

async function mountAuditLogs() {
  const wrapper = mount(AuditLogs);
  await flushPromises();
  return wrapper;
}

describe('AuditLogs.vue 审计动作中文标签', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    vi.mocked(apiClient.get).mockImplementation((url: string) => mockLogsResponse(url) as any);
  });

  it('v1.5.3 的 19 个动作与 api_key_rotate 均有中文标签，不落「未知操作」兜底', () => {
    for (const action of NEW_ACTIONS) {
      const label = actionLabel(action);
      expect(label).toBeTruthy();
      expect(label).not.toContain('未知操作');
      expect(label).not.toBe(action);
      // 映射表本身也必须命中（而不是靠 actionLabel 兜底分支）
      expect(actionLabels[action]).toBe(label);
    }
  });

  it('api_key_rotate 使用指定中文名「轮换API密钥」', () => {
    expect(actionLabels.api_key_rotate).toBe('轮换API密钥');
  });

  it('新增动作的中文名逐条有区分度，无重名', () => {
    const labels = NEW_ACTIONS.map((a) => actionLabels[a]);
    expect(new Set(labels).size).toBe(labels.length);
  });
});

describe('AuditLogs.vue 资源类型中文标签', () => {
  it('v1.5.3 新引入的资源类型均有中文名，不落「未知资源」兜底', () => {
    for (const type of V153_RESOURCE_TYPES) {
      const label = resourceTypeLabel(type);
      expect(label).toBeTruthy();
      expect(label).not.toContain('未知资源');
      expect(label).not.toBe(type);
    }
  });

  it('新增资源类型中文名逐条有区分度，无重名', () => {
    const labels = V153_RESOURCE_TYPES.map((t) => resourceTypeLabel(t));
    expect(new Set(labels).size).toBe(labels.length);
  });
});

describe('AuditLogs.vue actionTheme 对新前缀显式归类', () => {
  it('telegram_account_* 不再落入通用规则误判', () => {
    expect(actionTheme('telegram_account_created')).toBe('success');
    expect(actionTheme('telegram_account_enabled')).toBe('success');
    expect(actionTheme('telegram_account_disabled')).toBe('warning');
    expect(actionTheme('telegram_account_updated')).toBe('primary');
    expect(actionTheme('telegram_account_auth_failed')).toBe('warning');
    expect(actionTheme('telegram_account_deleted')).toBe('danger');
  });

  it('telegram_mirror_* 不再落入 default / 通用规则误判', () => {
    expect(actionTheme('telegram_mirror_feature_enabled')).toBe('success');
    expect(actionTheme('telegram_mirror_feature_disabled')).toBe('warning');
    expect(actionTheme('telegram_mirror_task_cancelled')).toBe('warning');
    expect(actionTheme('telegram_mirror_fallback_applied')).toBe('warning');
    expect(actionTheme('telegram_mirror_task_retried')).toBe('primary');
    expect(actionTheme('telegram_mirror_feature_enabled')).not.toBe('default');
    expect(actionTheme('telegram_mirror_task_cancelled')).not.toBe('default');
  });
});

describe('AuditLogs.vue 操作类型筛选与渲染', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    vi.mocked(apiClient.get).mockImplementation((url: string) => mockLogsResponse(url) as any);
  });

  it('新增动作全部出现在「操作类型」筛选选项中', async () => {
    const wrapper = await mountAuditLogs();
    const optionTexts = wrapper.findAll('.t-option-stub').map((o) => o.text());
    for (const action of NEW_ACTIONS) {
      expect(optionTexts).toContain(actionLabels[action]);
    }
  });

  it('表格渲染的中文标签不出现「未知操作 / 未知资源」兜底', async () => {
    const wrapper = await mountAuditLogs();
    const text = wrapper.text();
    for (const action of NEW_ACTIONS) {
      expect(text).toContain(actionLabels[action]);
    }
    for (const type of V153_RESOURCE_TYPES) {
      expect(text).toContain(resourceTypeLabel(type));
    }
    expect(text).not.toContain('未知操作');
    expect(text).not.toContain('未知资源');
  });
});
