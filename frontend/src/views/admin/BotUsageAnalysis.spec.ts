// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';

const get = vi.fn();

vi.mock('../../api/client', () => ({
  default: { get: (...args: unknown[]) => get(...args) },
}));

vi.mock('@/utils/echarts', () => ({
  init: () => ({ setOption: vi.fn(), resize: vi.fn(), dispose: vi.fn(), isDisposed: () => false }),
  getInstanceByDom: () => null,
  ECharts: class {},
}));

vi.mock('../../utils/echarts-theme', () => ({
  CHART_COLORS: { primary: '#000', success: '#000', teal: '#000' },
  tooltipBase: {},
  legendBase: {},
  areaGradient: () => ({}),
  ensureCyberTheme: vi.fn(async () => undefined),
}));

vi.mock('../../composables/useMobile', async () => {
  const { ref } = await import('vue');
  return { useMobile: () => ref(false) };
});

// 图表无关的 t-* 组件用轻量桩替换；Table 桩按列名渲染具名插槽，使单元格插槽也能被断言。
vi.mock('tdesign-vue-next', () => ({
  RadioGroup: { template: '<div><slot /></div>' },
  RadioButton: { template: '<label><slot /></label>' },
  Loading: { template: '<div><slot /></div>' },
  Table: {
    props: ['data', 'columns', 'pagination'],
    template: `
      <table class="t-table-stub">
        <tr v-for="(row, rowIndex) in (data || [])" :key="rowIndex">
          <td v-for="column in (columns || [])" :key="column.colKey">
            <slot :name="column.colKey" :row="row" :rowIndex="rowIndex" />
          </td>
        </tr>
      </table>`,
  },
  Input: {
    props: ['modelValue'],
    emits: ['update:modelValue'],
    template:
      '<input class="t-input-stub" :value="modelValue ?? \'\'" @input="$emit(\'update:modelValue\', $event.target.value)" />',
  },
  Select: {
    props: ['modelValue'],
    emits: ['update:modelValue'],
    template: '<select class="t-select-stub" :value="modelValue" @change="$emit(\'update:modelValue\', $event.target.value)" />',
  },
  Option: { props: ['value', 'label'], template: '<option />' },
  Button: {
    props: ['loading'],
    emits: ['click'],
    template: '<button class="t-button-stub" @click="$emit(\'click\')"><slot /></button>',
  },
  Pagination: { props: ['current', 'total', 'pageSize'], template: '<div class="t-pagination-stub" />' },
}));

import BotUsageAnalysis from './BotUsageAnalysis.vue';

const summaryPayload = {
  timeRange: '7d',
  downloads: 42,
  uniqueUsers: 7,
  totalBytes: '104857600',
  filesReceived: 18,
  receivedBytes: '734003200',
  trend: [
    { bucket: '2026-09-15 08:00:00', downloads: 12, bytes: '20971520', files: 4, fileBytes: '104857600' },
  ],
};

const usersPayload = {
  total: 1,
  page: 1,
  pageSize: 20,
  rows: [
    {
      telegramUserId: '80000000000000001',
      telegramUsername: '@alice',
      telegramDisplayName: 'Alice',
      filesReceived: 6,
      receivedBytes: '734003200',
      downloads: 11,
      lastReceivedAt: '2026-09-15T08:12:33.000Z',
      lastAccessedAt: null,
    },
  ],
};

function mountPage() {
  return mount(BotUsageAnalysis);
}

describe('BotUsageAnalysis', () => {
  beforeEach(() => {
    get.mockReset();
    get.mockImplementation(async (url: string, config?: { params?: Record<string, unknown> }) => {
      if (url === '/admin/bot-usage') return { data: { data: summaryPayload } };
      if (url === '/admin/bot-usage/users') {
        return { data: { data: { ...usersPayload, page: Number(config?.params?.page ?? 1) } } };
      }
      throw new Error(`unexpected url: ${url}`);
    });
  });

  it('汇总消费收到文件字段，并在趋势中保留 files/fileBytes', async () => {
    const wrapper = mountPage();
    await flushPromises();

    const summary = (wrapper.vm as unknown as { summary: typeof summaryPayload }).summary;
    expect(summary.filesReceived).toBe(18);
    expect(summary.receivedBytes).toBe('734003200');
    expect(summary.trend[0]).toMatchObject({ files: 4, fileBytes: '104857600' });
  });

  it('用户明细默认以全部时间拉取，行内直接给出 TG 用户 ID 与 @用户名（不泄露昵称）', async () => {
    const wrapper = mountPage();
    await flushPromises();

    expect(get).toHaveBeenCalledWith('/admin/bot-usage/users', {
      params: { page: 1, pageSize: 20, timeRange: 'all' },
    });

    const users = (wrapper.vm as unknown as { users: Record<string, unknown>[] }).users;
    expect(users).toHaveLength(1);
    expect(users[0]).toMatchObject({
      telegramUserId: '80000000000000001',
      telegramUsername: '@alice',
      filesReceived: 6,
      downloads: 11,
    });
    // 昵称既不展示也不进入前端模型
    expect(Object.keys(users[0])).not.toContain('telegramDisplayName');
    const rendered = wrapper.html();
    expect(rendered).toContain('@alice');
    expect(rendered).not.toContain('Alice');
  });

  it('筛选（关键字 + 时间范围）回到第 1 页并带上查询参数', async () => {
    const wrapper = mountPage();
    await flushPromises();
    get.mockClear();

    const vm = wrapper.vm as unknown as {
      userKeyword: string;
      userTimeRange: string;
      userPagination: { current: number };
      onUserFilterChange: () => void;
    };
    vm.userPagination.current = 3;
    vm.userKeyword = '  @alice  ';
    vm.userTimeRange = '7d';
    vm.onUserFilterChange();
    await flushPromises();

    expect(vm.userPagination.current).toBe(1);
    expect(get).toHaveBeenCalledWith('/admin/bot-usage/users', {
      params: { page: 1, pageSize: 20, timeRange: '7d', keyword: '@alice' },
    });
  });

  it('接口异常时清空用户列表并归零总数', async () => {
    get.mockImplementation(async (url: string) => {
      if (url === '/admin/bot-usage') return { data: { data: summaryPayload } };
      throw new Error('boom');
    });
    const wrapper = mountPage();
    await flushPromises();

    const vm = wrapper.vm as unknown as {
      users: unknown[];
      userPagination: { total: number };
    };
    expect(vm.users).toEqual([]);
    expect(vm.userPagination.total).toBe(0);
  });
});
