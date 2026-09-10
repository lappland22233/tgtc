// @vitest-environment jsdom
import { mount } from '@vue/test-utils';
import { describe, expect, it } from 'vitest';
import PreviewHeader from './PreviewHeader.vue';

/**
 * M6 拆分回归：头部从 FilePreviewDialog.vue 拆出后，
 * 导航按钮的显示条件、可用性与事件回传必须与拆分前一致。
 *
 * 特别保护：`fpv-playlist-toggle` 类名被 usePlaylistControls 的
 * 「点击切换按钮不收起面板」逻辑通过 closest() 依赖，改名会静默破坏交互。
 */

function mountHeader(overrides: Record<string, unknown> = {}) {
  return mount(PreviewHeader, {
    props: {
      name: '报告.pdf',
      hasPlaylist: true,
      isMediaCollection: true,
      activeIndex: 1,
      playlistLength: 4,
      hasPrev: true,
      hasNext: true,
      playlistOpen: false,
      isContinuousMedia: false,
      itemLabel: '音乐',
      ...overrides,
    },
    global: {
      stubs: { 't-icon': { template: '<i class="icon-stub" />' } },
    },
  });
}

describe('PreviewHeader（M6 拆分契约）', () => {
  it('展示文件名与播放进度，空名回退为「文件预览」', () => {
    expect(mountHeader().get('.fpv-name').text()).toBe('报告.pdf');
    expect(mountHeader({ name: '' }).get('.fpv-name').text()).toBe('文件预览');
  });

  it('展示当前进度 2 / 4', () => {
    expect(mountHeader().get('.fpv-playlist-indicator').text()).toBe('2 / 4');
  });

  it('无播放列表或非媒体集合时不渲染导航区', () => {
    expect(mountHeader({ hasPlaylist: false }).find('.fpv-playlist-indicator').exists()).toBe(false);
    expect(mountHeader({ isMediaCollection: false }).find('.fpv-playlist-indicator').exists()).toBe(false);
  });

  it('首位/末位时禁用对应导航按钮', () => {
    const both = mountHeader();
    expect(both.findAll('.fpv-nav-btn')[0]!.attributes('disabled')).toBeUndefined();
    expect(both.findAll('.fpv-nav-btn')[1]!.attributes('disabled')).toBeUndefined();

    const edge = mountHeader({ hasPrev: false, hasNext: false });
    expect(edge.findAll('.fpv-nav-btn')[0]!.attributes('disabled')).toBeDefined();
    expect(edge.findAll('.fpv-nav-btn')[1]!.attributes('disabled')).toBeDefined();
  });

  it('播放列表开关保留 fpv-playlist-toggle 类名并回传 toggle-playlist', async () => {
    const wrapper = mountHeader();
    const toggle = wrapper.get('.fpv-playlist-toggle');

    expect(toggle.classes()).toContain('fpv-nav-btn');
    expect(toggle.attributes('aria-controls')).toBe('fpv-playlist-panel');
    expect(toggle.attributes('aria-expanded')).toBe('false');

    await toggle.trigger('click');
    expect(wrapper.emitted('toggle-playlist')).toEqual([[]]);
  });

  it('展开态为开关按钮加上 fpv-active 视觉态', () => {
    expect(mountHeader({ playlistOpen: true }).get('.fpv-playlist-toggle').classes()).toContain('fpv-active');
  });

  it('仅持续播放媒体显示「收起」按钮', () => {
    expect(mountHeader({ isContinuousMedia: true }).findAll('.fpv-nav-btn')).toHaveLength(4);
    expect(mountHeader({ isContinuousMedia: false }).findAll('.fpv-nav-btn')).toHaveLength(3);
  });

  it('上一项 / 下一项 / 收起 / 关闭均只回传事件', async () => {
    const wrapper = mountHeader({ isContinuousMedia: true });
    const buttons = wrapper.findAll('.fpv-nav-btn');

    await buttons[0]!.trigger('click');
    await buttons[1]!.trigger('click');
    await buttons[3]!.trigger('click');
    await wrapper.get('.fpv-close').trigger('click');

    expect(wrapper.emitted('prev')).toEqual([[]]);
    expect(wrapper.emitted('next')).toEqual([[]]);
    expect(wrapper.emitted('minimize')).toEqual([[]]);
    expect(wrapper.emitted('close')).toEqual([[]]);
  });
});
