// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mount, type VueWrapper } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';

vi.mock('../../stores/auth', () => ({
  api: { get: vi.fn(), put: vi.fn(), post: vi.fn(), delete: vi.fn() },
}));

vi.mock('../../api/client', () => ({
  default: { get: vi.fn(), put: vi.fn(), post: vi.fn(), delete: vi.fn() },
}));

vi.mock('@/utils/message', () => ({
  default: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() },
}));

// Config.vue 模板中的 t-* 组件经 unplugin-vue-components 自动导入为
// tdesign-vue-next 的具名导出，因此 stub 必须放在该 mock 内（含 v-model 事件）。
vi.mock('tdesign-vue-next', () => ({
  DialogPlugin: { confirm: vi.fn(), alert: vi.fn(), info: vi.fn(), warning: vi.fn() },
  Form: { template: '<form><slot /></form>' },
  FormItem: { template: '<div class="t-form-item-stub"><slot /></div>' },
  Input: {
    props: ['modelValue'],
    emits: ['update:modelValue'],
    template:
      '<input class="t-input-stub" :value="modelValue ?? \'\'" @input="$emit(\'update:modelValue\', $event.target.value)" />',
  },
  InputNumber: {
    props: ['modelValue'],
    template: '<input class="t-input-number-stub" :value="modelValue ?? \'\'" />',
  },
  Switch: { props: ['value', 'modelValue'], template: '<span class="t-switch-stub" />' },
  RadioGroup: { template: '<div><slot /></div>' },
  Radio: { props: ['value'], template: '<label><slot /></label>' },
  Checkbox: { props: ['checked'], template: '<label><slot /></label>' },
  Tag: { template: '<span class="t-tag-stub"><slot /></span>' },
  Table: { template: '<div class="t-table-stub" />' },
  Dialog: { props: ['visible'], emits: ['update:visible', 'confirm'], template: '<div />' },
  Button: {
    props: ['disabled', 'loading'],
    emits: ['click'],
    template:
      '<button class="t-button-stub" :disabled="disabled || loading" @click="$emit(\'click\')"><slot /></button>',
  },
}));

vi.mock('../../composables/useMobile', async () => {
  const { ref } = await import('vue');
  return { useMobile: () => ref(false) };
});

vi.mock('vue-router', () => ({
  onBeforeRouteLeave: vi.fn(),
}));

import { api } from '../../stores/auth';
import apiClient from '../../api/client';
import MessagePlugin from '@/utils/message';
import { usePublicConfigStore, DEFAULT_SITE_TITLE } from '../../stores/public-config';
import Config from './Config.vue';

/** 刷新微任务队列：读取链路有多层 await（store 去重 → then/finally → 组件回填），需足够轮数 */
async function flushMicrotasks(wrapper?: VueWrapper) {
  for (let i = 0; i < 8; i += 1) {
    await Promise.resolve();
    if (wrapper) await wrapper.vm.$nextTick();
  }
}

function findButton(wrapper: VueWrapper, text: string) {
  const btn = wrapper.findAll('button.t-button-stub').find((b) => b.text().includes(text));
  if (!btn) throw new Error(`找不到按钮：${text}`);
  return btn;
}

function mountConfig() {
  return mount(Config, {
    global: {
      plugins: [setActivePinia(createPinia())],
    },
  });
}

describe('Config.vue 网站标题保存与同步', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    document.title = DEFAULT_SITE_TITLE;
    // Config 挂载会并行加载各区块配置：标题走 apiClient（public-config store），
    // 其余走 auth 导出的 api；统一返回空数据，避免阻塞测试焦点。
    vi.mocked(apiClient.get).mockResolvedValue({ data: { data: { siteTitle: '服务端标题' } } });
    vi.mocked(api.get).mockImplementation(async (url: string) => {
      if (url.startsWith('/admin/banned-ips')) {
        return { data: { data: { list: [], total: 0 } } };
      }
      return { data: { data: {} } };
    });
    vi.mocked(api.put).mockResolvedValue({ data: { data: {} } });
  });

  it('保存成功：提交共享 store，侧栏来源与浏览器标签立即同步', async () => {
    const wrapper = mountConfig();
    await flushMicrotasks(wrapper);

    const store = usePublicConfigStore();
    // 表单初始值来自共享读取的服务端标题
    const titleInput = wrapper.find('input[name="site-title"]');
    expect((titleInput.element as HTMLInputElement).value).toBe('服务端标题');

    await titleInput.setValue('全新站名');
    await findButton(wrapper, '保存网站标题').trigger('click');
    await flushMicrotasks(wrapper);

    expect(api.put).toHaveBeenCalledWith('/admin/config', {
      key: 'SITE_TITLE',
      value: '全新站名',
      description: '网站浏览器标题',
    });
    expect(store.siteTitle).toBe('全新站名');
    expect(document.title).toBe('全新站名');
    expect(MessagePlugin.success).toHaveBeenCalledWith('网站标题已保存');
  });

  it('保存失败：提示错误且不修改全局标题', async () => {
    vi.mocked(api.put).mockRejectedValueOnce(new Error('服务端拒绝'));
    const wrapper = mountConfig();
    await flushMicrotasks(wrapper);

    await wrapper.find('input[name="site-title"]').setValue('不会生效的标题');
    await findButton(wrapper, '保存网站标题').trigger('click');
    await flushMicrotasks(wrapper);

    expect(MessagePlugin.error).toHaveBeenCalledWith('服务端拒绝');
    expect(usePublicConfigStore().siteTitle).toBe('服务端标题');
    expect(document.title).toBe('服务端标题');
  });

  it('未保存草稿不改变全局标题', async () => {
    const wrapper = mountConfig();
    await flushMicrotasks(wrapper);

    await wrapper.find('input[name="site-title"]').setValue('仅本地草稿');
    await flushMicrotasks(wrapper);

    expect(usePublicConfigStore().siteTitle).toBe('服务端标题');
    expect(document.title).toBe('服务端标题');
  });

  it('标题加载失败：禁用保存并显示重载提示，不用默认值覆盖服务端', async () => {
    vi.mocked(apiClient.get).mockRejectedValueOnce(new Error('配置读取失败'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const wrapper = mountConfig();
    await flushMicrotasks(wrapper);
    warn.mockRestore();

    const saveButton = findButton(wrapper, '保存网站标题');
    expect(saveButton.attributes('disabled')).toBeDefined();
    expect(wrapper.text()).toContain('已禁用保存');
  });
});
