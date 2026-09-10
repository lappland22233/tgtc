// @vitest-environment jsdom
import { mount } from '@vue/test-utils';
import { describe, expect, it } from 'vitest';
import FileListAddressBar from './FileListAddressBar.vue';
import FileListToolbar from './FileListToolbar.vue';
import FileListBatchActions from './FileListBatchActions.vue';

/**
 * M6 拆分回归：FileList.vue 的「页面外壳」三件套（地址栏 / 工具栏 / 批量操作区）
 * 从宿主拆出后，显示条件、无障碍属性与事件契约必须与拆分前一致。
 *
 * TDesign 组件在测试环境未全局注册，统一用最小替身承接插槽与事件。
 */

const stubs = {
  't-icon': { template: '<i class="icon-stub" />' },
  't-button': {
    props: ['disabled', 'loading'],
    template: '<button class="btn-stub" :disabled="disabled"><slot /></button>',
  },
  't-tag': {
    emits: ['close'],
    template: '<span class="tag-stub" @click="$emit(\'close\')"><slot /></span>',
  },
  't-input': {
    props: ['modelValue'],
    emits: ['update:modelValue', 'enter', 'clear'],
    template: `
      <div class="input-stub">
        <input class="input-el" :value="modelValue" @input="$emit('update:modelValue', $event.target.value)" />
        <button class="input-enter" @click="$emit('enter')" />
        <button class="input-clear" @click="$emit('clear')" />
      </div>`,
  },
};

const folder = (id: string, name: string) => ({ id, name }) as never;

describe('FileListAddressBar（M6 拆分契约）', () => {
  function mountBar(overrides: Record<string, unknown> = {}) {
    return mount(FileListAddressBar, {
      props: {
        currentFolderId: null,
        breadcrumb: [],
        dragOverFolderId: null,
        rootDropTarget: '__root__',
        showMobileBack: false,
        parentFolderId: null,
        ...overrides,
      },
      global: { stubs },
    });
  }

  it('根目录为当前位置时高亮「我的文件」', () => {
    const items = mountBar().findAll('.fl-path-item');
    expect(items).toHaveLength(1);
    expect(items[0]!.classes()).toContain('is-current');
    expect(items[0]!.text()).toContain('我的文件');
  });

  it('渲染面包屑并把最后一段标为当前页', () => {
    const wrapper = mountBar({
      currentFolderId: 'd2',
      breadcrumb: [folder('d1', '文档'), folder('d2', '报表')],
    });
    const items = wrapper.findAll('.fl-path-item');

    expect(items).toHaveLength(3);
    expect(items[0]!.classes()).not.toContain('is-current');
    expect(items[1]!.text()).toBe('文档');
    expect(items[2]!.classes()).toContain('is-current');
    expect(items[2]!.attributes('aria-current')).toBe('page');
  });

  it('点击面包屑回传目标文件夹 ID，点击「我的文件」回传 null', async () => {
    const wrapper = mountBar({
      currentFolderId: 'd2',
      breadcrumb: [folder('d1', '文档'), folder('d2', '报表')],
    });
    const items = wrapper.findAll('.fl-path-item');

    await items[0]!.trigger('click');
    await items[2]!.trigger('click');

    expect(wrapper.emitted('navigate')).toEqual([[null], ['d2']]);
  });

  it('拖拽悬停根目录时高亮，并以 rootDropTarget 回传拖放事件', async () => {
    const wrapper = mountBar({ dragOverFolderId: '__root__' });
    const root = wrapper.findAll('.fl-path-item')[0]!;

    expect(root.classes()).toContain('drag-over');

    await root.trigger('dragover');
    await root.trigger('dragleave');
    await root.trigger('drop');

    expect(wrapper.emitted('folder-drag-over')?.[0]?.[1]).toBe('__root__');
    expect(wrapper.emitted('folder-drag-leave')?.[0]?.[1]).toBe('__root__');
    expect(wrapper.emitted('drop-on-folder')?.[0]?.[1]).toBe('__root__');
  });

  it('新建文件夹 / 上传入口只回传事件', async () => {
    const wrapper = mountBar();
    const buttons = wrapper.findAll('.btn-stub');

    await buttons[0]!.trigger('click');
    await buttons[1]!.trigger('click');

    expect(wrapper.emitted('create-folder')).toEqual([[]]);
    expect(wrapper.emitted('upload')).toEqual([[]]);
  });

  it('移动端返回按钮按 showMobileBack 显隐，点击回传父级 ID', async () => {
    expect(mountBar().find('.fl-mobile-back').exists()).toBe(false);

    const wrapper = mountBar({ showMobileBack: true, parentFolderId: 'd1' });
    await wrapper.get('.fl-mobile-back').trigger('click');

    expect(wrapper.emitted('navigate')).toEqual([['d1']]);
  });
});

describe('FileListToolbar（M6 拆分契约）', () => {
  function mountToolbar(overrides: Record<string, unknown> = {}) {
    return mount(FileListToolbar, {
      props: { search: '', tagButtonLabel: '管理标签', ...overrides },
      global: { stubs },
    });
  }

  it('输入变化经 v-model:search 回传', async () => {
    const wrapper = mountToolbar({ search: '旧值' });

    expect(wrapper.get<HTMLInputElement>('.input-el').element.value).toBe('旧值');

    await wrapper.get('.input-el').setValue('报表');
    expect(wrapper.emitted('update:search')).toEqual([['报表']]);
  });

  it('提交表单与回车均触发 search，清空触发 clear', async () => {
    const wrapper = mountToolbar();

    await wrapper.get('form').trigger('submit');
    await wrapper.get('.input-enter').trigger('click');
    await wrapper.get('.input-clear').trigger('click');

    expect(wrapper.emitted('search')).toHaveLength(2);
    expect(wrapper.emitted('clear')).toEqual([[]]);
  });

  it('标签入口文案由宿主注入，点击回传 manage-tags', async () => {
    const wrapper = mountToolbar({ tagButtonLabel: '标签筛选' });
    // 工具栏内共两个按钮：搜索（表单内）与标签入口（右侧）
    const buttons = wrapper.findAll('.btn-stub');
    const tagButton = buttons[buttons.length - 1]!;

    expect(tagButton.text()).toContain('标签筛选');

    await tagButton.trigger('click');
    expect(wrapper.emitted('manage-tags')).toEqual([[]]);
  });
});

describe('FileListBatchActions（M6 拆分契约）', () => {
  function mountBatch(overrides: Record<string, unknown> = {}) {
    return mount(FileListBatchActions, {
      props: {
        selectedCount: 0,
        imageCount: 0,
        busy: false,
        tagFilters: [],
        markdown: '',
        ...overrides,
      },
      global: { stubs },
    });
  }

  it('未选中任何文件时不渲染批量栏', () => {
    expect(mountBatch().find('.fl-batchbar').exists()).toBe(false);
  });

  it('选中时展示数量与全部批量入口；无图片时不展示 MK 按钮', async () => {
    const wrapper = mountBatch({ selectedCount: 3 });
    const buttons = wrapper.findAll('.btn-stub');

    expect(wrapper.get('.fl-batchbar-count').text()).toBe('已选 3 项');
    expect(wrapper.text()).not.toContain('批量 MK');
    // 复制下载链接 / 批量标签 / 移动到 / 批量删除 / 清除选择
    expect(buttons).toHaveLength(5);

    await buttons[0]!.trigger('click');
    await buttons[1]!.trigger('click');
    await buttons[2]!.trigger('click');
    await buttons[3]!.trigger('click');
    await buttons[4]!.trigger('click');

    expect(wrapper.emitted('copy-links')).toEqual([[]]);
    expect(wrapper.emitted('batch-tag')).toEqual([[]]);
    expect(wrapper.emitted('move')).toEqual([[]]);
    expect(wrapper.emitted('batch-delete')).toEqual([[]]);
    expect(wrapper.emitted('clear-selection')).toEqual([[]]);
  });

  it('存在可直链图片时额外展示带数量的 MK 按钮', async () => {
    const wrapper = mountBatch({ selectedCount: 4, imageCount: 2 });
    const mkButton = wrapper.findAll('.btn-stub')[0]!;

    expect(mkButton.text()).toContain('批量 MK（2）');

    await mkButton.trigger('click');
    expect(wrapper.emitted('convert-markdown')).toEqual([[]]);
  });

  it('批量操作进行中禁用删除与清除按钮', () => {
    const wrapper = mountBatch({ selectedCount: 1, busy: true });
    const buttons = wrapper.findAll('.btn-stub');
    const deleteButton = buttons[buttons.length - 2]!;
    const clearButton = buttons[buttons.length - 1]!;

    expect(deleteButton.attributes('disabled')).toBeDefined();
    expect(clearButton.attributes('disabled')).toBeDefined();
  });

  it('标签筛选条展示宿主解析出的名称，关闭与清空分别回传', async () => {
    const wrapper = mountBatch({
      tagFilters: [{ id: 't1', name: '报表' }, { id: 't2', name: '归档' }],
    });
    const tags = wrapper.findAll('.tag-stub');

    expect(tags.map((tag) => tag.text())).toEqual(['报表', '归档']);

    await tags[0]!.trigger('click');
    await wrapper.get('.fl-tagfilters .btn-stub').trigger('click');

    expect(wrapper.emitted('remove-tag')).toEqual([['t1']]);
    expect(wrapper.emitted('clear-tags')).toEqual([[]]);
  });

  it('Markdown 结果区按内容显隐，支持复制、关闭与外部编辑', async () => {
    expect(mountBatch().find('.fl-markdown').exists()).toBe(false);

    const wrapper = mountBatch({ markdown: '![a](/s/1)' });
    expect(wrapper.get('.fl-markdown-title').text()).toBe('Markdown 结果');

    const buttons = wrapper.findAll('.fl-markdown .btn-stub');
    await buttons[0]!.trigger('click');
    expect(wrapper.emitted('copy-markdown')).toEqual([[]]);

    await buttons[1]!.trigger('click');
    expect(wrapper.emitted('update:markdown')).toEqual([['']]);
  });
});
