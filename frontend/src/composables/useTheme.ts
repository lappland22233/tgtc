import { computed, ref } from 'vue';

export type ThemePreference = 'light' | 'dark' | 'system';
export type ResolvedTheme = 'light' | 'dark';

const STORAGE_KEY = 'filecloud-theme';

function readStoredPreference(): ThemePreference {
  if (typeof window === 'undefined') return 'system';
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored === 'light' || stored === 'dark') return stored;
  } catch {
    // 受限环境忽略 localStorage 读取异常
  }
  return 'system';
}

function readSystemDark(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false;
  return window.matchMedia('(prefers-color-scheme: dark)').matches;
}

const themePreference = ref<ThemePreference>(readStoredPreference());
const systemDark = ref<boolean>(readSystemDark());
const resolvedTheme = computed<ResolvedTheme>(() => {
  if (themePreference.value === 'light' || themePreference.value === 'dark') {
    return themePreference.value;
  }
  return systemDark.value ? 'dark' : 'light';
});

let mediaListenerRegistered = false;
let chartRefreshScheduled = false;

function notifyCharts() {
  if (chartRefreshScheduled || typeof window === 'undefined') return;
  chartRefreshScheduled = true;
  void import('@/utils/echarts-theme')
    .then(({ refreshChartTheme }) => refreshChartTheme())
    .finally(() => {
      chartRefreshScheduled = false;
    });
}

export function applyThemeToDocument(theme: ResolvedTheme): void {
  if (typeof document === 'undefined') return;
  const root = document.documentElement;
  root.setAttribute('data-theme', theme);
  if (theme === 'dark') {
    root.setAttribute('theme-mode', 'dark');
  } else {
    root.removeAttribute('theme-mode');
  }
  const canvasColor =
    typeof getComputedStyle === 'function'
      ? getComputedStyle(root).getPropertyValue('--workspace-canvas').trim()
      : '';
  const fallbackColor = theme === 'dark' ? '#1b211e' : '#f6f5ef';
  document
    .querySelector('meta[name="theme-color"]')
    ?.setAttribute('content', canvasColor || fallbackColor);
}

export function setThemePreference(next: ThemePreference, refreshCharts = true): void {
  themePreference.value = next;
  if (typeof window !== 'undefined') {
    try {
      if (next === 'system') {
        localStorage.removeItem(STORAGE_KEY);
      } else {
        localStorage.setItem(STORAGE_KEY, next);
      }
    } catch {
      // ignore storage errors
    }
  }
  applyThemeToDocument(resolvedTheme.value);
  if (refreshCharts) notifyCharts();
}

export function cycleTheme(): ThemePreference {
  const next: ThemePreference = resolvedTheme.value === 'dark' ? 'light' : 'dark';
  setThemePreference(next);
  return next;
}

export function initThemeSystem(): void {
  themePreference.value = readStoredPreference();
  systemDark.value = readSystemDark();
  applyThemeToDocument(resolvedTheme.value);

  if (!mediaListenerRegistered && typeof window !== 'undefined' && typeof window.matchMedia === 'function') {
    mediaListenerRegistered = true;
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    mq.addEventListener('change', (e) => {
      systemDark.value = e.matches;
      if (themePreference.value === 'system') {
        applyThemeToDocument(resolvedTheme.value);
        notifyCharts();
      }
    });
  }

  if (typeof window !== 'undefined') {
    (window as Window & { __setFileCloudTheme?: (theme: 'light' | 'dark' | 'system') => void }).__setFileCloudTheme = (
      theme: 'light' | 'dark' | 'system',
    ) => {
      setThemePreference(theme);
    };
  }
}

export function useTheme() {
  return {
    themePreference,
    resolvedTheme,
    isDark: computed(() => resolvedTheme.value === 'dark'),
    setTheme: setThemePreference,
    cycleTheme,
  };
}
