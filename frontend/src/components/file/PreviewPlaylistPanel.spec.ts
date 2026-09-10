// @vitest-environment jsdom
import { mount } from '@vue/test-utils';
import { describe, expect, it, vi } from 'vitest';

// ThumbnailImg → utils/thumbnail 间接引入 TDesign 子路径（其样式为裸 .css，
// Node 侧不可直接加载），与既有 SideNav.spec.ts 一致地打桩。
vi.mock('tdesign-vue-next/es/message', () => ({
  MessagePlugin: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() },
}));
vi.mock('tdesign-vue-next/es/dialog', () => ({
  DialogPlugin: { confirm: vi.fn(), alert: vi.fn(), info: vi.fn(), warning: vi.fn() },
}));

import PreviewPlaylistPanel from './PreviewPlaylistPanel.vue';
import type { MediaSessionItem } from '../../stores/mediaPlayback';
import type { PreviewKind } from '../../utils/preview';

/**
 * M6 拆分回归：播放列表面板从 FilePreviewDialog.vue 拆出为展示组件后，
 * 必须保持与拆分前完全一致的可见性规则、渲染结构与交互契约。
 */

function item(id: string, name: string, extra: Partial<MediaSessionItem> = {}): MediaSessionItem {
  return {
    id,
    name,
    mimeType: 'audio/mpeg',
    kind: 'audio',
    size: 1_500_000,
    src: `/api/files/${id}/stream`,
    ...extra,
  };
}

const items = [item('a', '第一首'), item('b', '第二首'), item('c', '第三首')];

function mountPanel(overrides: Partial<Record<string, unknown>> = {}) {
  return mount(PreviewPlaylistPanel, {
    props: {
      open: true,
      items,
      activeIndex: 1,
      kind: 'audio' as PreviewKind,
      title: '音乐播放列表',
      itemLabel: '音乐',
      thumbContext: 'u:user-1',
      ...overrides,
    },
    global: {
      stubs: {
        't-icon': { template: '<i class="icon-stub" />' },
        ThumbnailImg: { template: '<div class="thumb-stub" />' },
      },
    },
  });
}

describe('PreviewPlaylistPanel（M6 拆分契约）', () => {
  it('open 且列表长度 > 1 时渲染面板与全部条目', () => {
    const wrapper = mountPanel();

    expect(wrapper.find('#fpv-playlist-panel').exists()).toBe(true);
    expect(wrapper.findAll('.fpv-playlist-item')).toHaveLength(3);
    expect(wrapper.get('.fpv-playlist-title').text()).toBe('音乐播放列表');
    expect(wrapper.get('.fpv-playlist-count').text()).toBe('3 个音乐');
  });

  it('open 但列表只有一项时不渲染（与原 hasPlaylist 语义一致）', () => {
    const wrapper = mountPanel({ items: [item('a', '唯一')] });

    expect(wrapper.find('#fpv-playlist-panel').exists()).toBe(false);
  });

  it('open=false 时不渲染', () => {
    const wrapper = mountPanel({ open: false });

    expect(wrapper.find('#fpv-playlist-panel').exists()).toBe(false);
  });

  it('高亮当前项并渲染序号/元信息', () => {
    const wrapper = mountPanel();
    const rendered = wrapper.findAll('.fpv-playlist-item');

    expect(rendered[1]!.classes()).toContain('fpv-playing');
    expect(rendered[1]!.attributes('aria-current')).toBe('true');
    expect(rendered[0]!.attributes('aria-current')).toBeUndefined();
    expect(rendered[0]!.get('.fpv-playlist-index').text()).toBe('1');
    // formatSizeCompact：1500000 bytes → 1.4 MB（1 位小数，与拆分前一致）
    expect(rendered[0]!.get('.fpv-playlist-meta').text()).toContain('1.4 MB');
  });

  it('点击条目回传 switch(index)，不自行切换', async () => {
    const wrapper = mountPanel();

    await wrapper.findAll('.fpv-playlist-item')[2]!.trigger('click');

    expect(wrapper.emitted('switch')).toEqual([[2]]);
  });

  it('点击收起按钮回传 update:open=false', async () => {
    const wrapper = mountPanel();

    await wrapper.get('.fpv-playlist-close').trigger('click');

    expect(wrapper.emitted('update:open')).toEqual([[false]]);
  });

  it('图片类别渲染缩略图，其他类别渲染序号', () => {
    const imageWrapper = mountPanel({ kind: 'image' as PreviewKind });
    expect(imageWrapper.findAll('.thumb-stub')).toHaveLength(3);
    expect(imageWrapper.find('.fpv-playlist-index').exists()).toBe(false);

    const audioWrapper = mountPanel({ kind: 'audio' as PreviewKind });
    expect(audioWrapper.find('.thumb-stub').exists()).toBe(false);
    expect(audioWrapper.findAll('.fpv-playlist-index')).toHaveLength(3);
  });

  it('向宿主暴露真实面板 DOM（供“点击面板外收起”判断）', () => {
    const wrapper = mountPanel();
    const exposed = (wrapper.vm as unknown as { panelEl: HTMLElement | null }).panelEl;

    expect(exposed).toBeInstanceOf(HTMLElement);
    expect(exposed?.id).toBe('fpv-playlist-panel');
  });
});
