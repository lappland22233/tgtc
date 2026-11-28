// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import ThemeToggle from '@/components/ThemeToggle.vue';
import {
  useTheme,
  initThemeSystem,
  setThemePreference,
  cycleTheme,
} from './useTheme';

const STORAGE_KEY = 'filecloud-theme';

type ChangeListener = (event: MediaQueryListEvent) => void;

function installMatchMedia(initialDark = false) {
  let darkMatches = initialDark;
  const listeners = new Set<ChangeListener>();

  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    configurable: true,
    value: vi.fn().mockImplementation((query: string) => ({
      media: query,
      get matches() {
        return darkMatches;
      },
      onchange: null,
      addEventListener: (_type: string, cb: ChangeListener) => {
        listeners.add(cb);
      },
      removeEventListener: (_type: string, cb: ChangeListener) => {
        listeners.delete(cb);
      },
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  });

  return {
    setDark(next: boolean) {
      darkMatches = next;
      const evt = { matches: next } as MediaQueryListEvent;
      for (const cb of listeners) cb(evt);
    },
  };
}

describe('useTheme & ThemeToggle', () => {
  let themeMedia: ReturnType<typeof installMatchMedia>;

  beforeEach(() => {
    localStorage.removeItem(STORAGE_KEY);
    document.documentElement.removeAttribute('data-theme');
    document.documentElement.removeAttribute('theme-mode');
    document.head.innerHTML = '<meta name="theme-color" content="#f6f5ef">';
    themeMedia = installMatchMedia(false);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('无本地偏好时默认跟随系统，并同步 data-theme 与 theme-mode', () => {
    initThemeSystem();
    const { themePreference, resolvedTheme, isDark } = useTheme();
    expect(themePreference.value).toBe('system');
    expect(resolvedTheme.value).toBe('light');
    expect(isDark.value).toBe(false);
    expect(document.documentElement.getAttribute('data-theme')).toBe('light');
    expect(document.documentElement.hasAttribute('theme-mode')).toBe(false);

    themeMedia.setDark(true);
    expect(resolvedTheme.value).toBe('dark');
    expect(isDark.value).toBe(true);
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
    expect(document.documentElement.getAttribute('theme-mode')).toBe('dark');
  });

  it('setThemePreference 会持久化 light/dark 并在 system 时清理 localStorage', () => {
    initThemeSystem();
    setThemePreference('dark', false);
    expect(localStorage.getItem(STORAGE_KEY)).toBe('dark');
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
    expect(document.documentElement.getAttribute('theme-mode')).toBe('dark');

    setThemePreference('system', false);
    expect(localStorage.getItem(STORAGE_KEY)).toBeNull();
    expect(document.documentElement.getAttribute('data-theme')).toBe('light');
    expect(document.documentElement.hasAttribute('theme-mode')).toBe(false);
  });

  it('能从 localStorage 恢复已保存的主题偏好', () => {
    localStorage.setItem(STORAGE_KEY, 'dark');
    initThemeSystem();
    const { themePreference, resolvedTheme } = useTheme();
    expect(themePreference.value).toBe('dark');
    expect(resolvedTheme.value).toBe('dark');
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
  });

  it('cycleTheme 在浅色与深色之间切换', () => {
    setThemePreference('light', false);
    expect(cycleTheme()).toBe('dark');
    expect(useTheme().resolvedTheme.value).toBe('dark');
    expect(cycleTheme()).toBe('light');
    expect(useTheme().resolvedTheme.value).toBe('light');
  });

  it('ThemeToggle segmented 模式渲染三态按钮并切换主题', async () => {
    setThemePreference('system', false);
    const wrapper = mount(ThemeToggle, { props: { variant: 'segmented' } });
    const radios = wrapper.findAll('[role="radio"]');
    expect(radios).toHaveLength(3);
    expect(radios.map((r) => r.text())).toEqual(['浅色', '深色', '跟随系统']);
    expect(radios[2].attributes('aria-checked')).toBe('true');

    await radios[1].trigger('click');
    expect(useTheme().themePreference.value).toBe('dark');
    expect(radios[1].attributes('aria-checked')).toBe('true');

    await radios[0].trigger('click');
    expect(useTheme().themePreference.value).toBe('light');
    expect(radios[0].attributes('aria-checked')).toBe('true');
  });

  it('ThemeToggle icon 模式支持快捷键式点击切换明暗主题', async () => {
    setThemePreference('light', false);
    const wrapper = mount(ThemeToggle, { props: { variant: 'icon' } });
    const btn = wrapper.find('button.theme-toggle-btn');
    expect(btn.exists()).toBe(true);

    await btn.trigger('click');
    expect(useTheme().resolvedTheme.value).toBe('dark');
  });
});
