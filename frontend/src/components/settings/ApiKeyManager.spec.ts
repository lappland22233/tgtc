// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mount, type VueWrapper } from '@vue/test-utils';

vi.mock('@/utils/message', () => ({
  default: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() },
}));

vi.mock('../../api/api-keys', () => ({
  listApiKeys: vi.fn(),
  createApiKey: vi.fn(),
  revokeApiKey: vi.fn(),
  rotateApiKey: vi.fn(),
  revealApiKey: vi.fn(),
  getApiKeyAllowlist: vi.fn(),
  setApiKeyAllowlist: vi.fn(),
  listApiKeyUsage: vi.fn(),
}));

// t-* 组件经 unplugin-vue-components 自动导入为 tdesign-vue-next 具名导出，
// 因此 stub 必须放在该 mock 内；Table stub 渲染每行的 op 插槽以便测试行内操作。
vi.mock('tdesign-vue-next', () => ({
  Table: {
    props: ['data', 'columns'],
    template:
      '<div class="t-table-stub"><div v-for="row in (data || [])" :key="row.id" class="t-table-row">'
      + '<slot name="op" :row="row" /></div></div>',
  },
  Dialog: {
    props: ['visible', 'header'],
    template:
      '<div v-if="visible" class="t-dialog-stub"><div class="t-dialog-header">{{ header }}</div><slot /></div>',
  },
  Input: {
    props: ['modelValue', 'value'],
    emits: ['update:modelValue'],
    template:
      '<input class="t-input-stub" :value="modelValue ?? value ?? \'\'" '
      + '@input="$emit(\'update:modelValue\', $event.target.value)" />',
  },
  Textarea: { props: ['modelValue'], template: '<textarea class="t-textarea-stub" />' },
  Button: {
    props: ['disabled', 'loading'],
    emits: ['click'],
    template: '<button class="t-button-stub" :disabled="disabled || loading" @click="$emit(\'click\')"><slot /></button>',
  },
  Link: {
    props: ['disabled', 'theme'],
    emits: ['click'],
    template: '<a class="t-link-stub" @click="$emit(\'click\')"><slot /></a>',
  },
  Alert: { props: ['theme'], template: '<div class="t-alert-stub"><slot /></div>' },
  Tag: { template: '<span class="t-tag-stub"><slot /></span>' },
  Space: { template: '<span class="t-space-stub"><slot /></span>' },
  Popconfirm: { template: '<span class="t-popconfirm-stub"><slot /></span>' },
  Loading: { template: '<div class="t-loading-stub"><slot /></div>' },
  Icon: { template: '<i class="t-icon-stub" />' },
}));

import MessagePlugin from '@/utils/message';
import {
  listApiKeys,
  createApiKey,
  revealApiKey,
  type ApiKeySummary,
} from '../../api/api-keys';
import ApiKeyManager from './ApiKeyManager.vue';

const revealableKey: ApiKeySummary = {
  id: 'key-1',
  name: '部署脚本',
  prefix: 'tgtc_a1b2c3d4',
  createdAt: '2026-09-01T00:00:00.000Z',
  lastUsedAt: null,
  revokedAt: null,
  revealable: true,
};

async function flush(wrapper?: VueWrapper) {
  for (let i = 0; i < 6; i += 1) {
    await Promise.resolve();
    if (wrapper) await wrapper.vm.$nextTick();
  }
}

function findButton(wrapper: VueWrapper, text: string) {
  const btn = wrapper.findAll('button.t-button-stub').find((b) => b.text().includes(text));
  if (!btn) throw new Error(`找不到按钮：${text}`);
  return btn;
}

describe('ApiKeyManager 创建与查看流程', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(listApiKeys).mockResolvedValue([revealableKey]);
    vi.mocked(createApiKey).mockResolvedValue({
      id: 'key-2',
      name: '新密钥',
      prefix: 'tgtc_zzzzzzzz',
      key: 'tgtc_zzzzzzzz_full_secret_value',
      createdAt: '2026-09-15T00:00:00.000Z',
    });
    vi.mocked(revealApiKey).mockResolvedValue({ key: 'tgtc_a1b2c3d4_full_secret_value' });
  });

  it('创建成功弹窗不再提示“无法再次查看”，并展示明文与复制入口', async () => {
    const wrapper = mount(ApiKeyManager);
    await flush(wrapper);

    await findButton(wrapper, '创建密钥').trigger('click');
    await wrapper.find('input.t-input-stub').setValue('新密钥');
    await findButton(wrapper, '确认创建').trigger('click');
    await flush(wrapper);

    expect(createApiKey).toHaveBeenCalledWith('新密钥');
    const text = wrapper.text();
    expect(text).not.toContain('无法再次查看');
    expect(text).toContain('请妥善保存此密钥');
    // 明文展示 + 复制入口仍在
    expect(wrapper.findAll('input.t-input-stub').some((i) => (i.element as HTMLInputElement).value === 'tgtc_zzzzzzzz_full_secret_value')).toBe(true);
    expect(findButton(wrapper, '复制').exists()).toBe(true);
    expect(findButton(wrapper, '我已保存，关闭').exists()).toBe(true);
  });

  it('列表「查看」可回显完整密钥，并保留防泄露提示', async () => {
    const wrapper = mount(ApiKeyManager);
    await flush(wrapper);

    const revealLink = wrapper.findAll('a.t-link-stub').find((a) => a.text() === '查看');
    expect(revealLink).toBeDefined();
    await revealLink!.trigger('click');
    await flush(wrapper);

    expect(revealApiKey).toHaveBeenCalledWith('key-1');
    const text = wrapper.text();
    expect(text).toContain('查看密钥：部署脚本');
    expect(text).toContain('请勿将密钥写入日志或公开仓库');
    expect(wrapper.findAll('input.t-input-stub').some((i) => (i.element as HTMLInputElement).value === 'tgtc_a1b2c3d4_full_secret_value')).toBe(true);
  });

  it('回显失败时提示错误且不打开弹窗', async () => {
    vi.mocked(revealApiKey).mockRejectedValueOnce(new Error('历史密钥无法回显'));
    const wrapper = mount(ApiKeyManager);
    await flush(wrapper);

    const revealLink = wrapper.findAll('a.t-link-stub').find((a) => a.text() === '查看');
    await revealLink!.trigger('click');
    await flush(wrapper);

    expect(MessagePlugin.error).toHaveBeenCalledWith('历史密钥无法回显');
    expect(wrapper.text()).not.toContain('查看密钥：');
  });
});
