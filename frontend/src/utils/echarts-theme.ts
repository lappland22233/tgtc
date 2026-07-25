// ============================================================
// FileCloud ECharts Theme — Cloudscape dual-theme chart system
// Uses tree-shaken echarts core (./echarts) instead of full barrel
// ============================================================

import echarts from './echarts';

/* ---- Color Palette (Cloudscape-aligned, high readability) ---- */
export const CHART_COLORS = {
  primary:    '#0972D3',
  success:    '#037F0C',
  warning:    '#8C6A00',
  danger:     '#D13212',
  info:       '#0E7490',
  purple:     '#7B2D8B',
  violet:     '#7B2D8B',
  orange:     '#D36609',
  teal:       '#0D9488',
  blue:       '#1D4ED8',
  slate:      '#5F6B7A',
  pink:       '#BE185D',
  emerald:    '#059669',
  amber:      '#B45309',
  indigo:     '#4338CA',
  cyan:       '#0891B2',
  lime:       '#4D7C0F',
} as const;

/* ---- Dark theme palette (brighter variants for dark surfaces) ---- */
export const CHART_COLORS_DARK = {
  primary:    '#539FE5',
  success:    '#53D769',
  warning:    '#C7A830',
  danger:     '#E8604C',
  info:       '#22D3EE',
  purple:     '#C084FC',
  violet:     '#C084FC',
  orange:     '#FB923C',
  teal:       '#2DD4BF',
  blue:       '#60A5FA',
  slate:      '#8895A7',
  pink:       '#F472B6',
  emerald:    '#34D399',
  amber:      '#FBBF24',
  indigo:     '#818CF8',
  cyan:       '#22D3EE',
  lime:       '#A3E635',
} as const;

/* ---- Status-code colors ---- */
export const STATUS_COLORS: Record<string, string> = {
  '2xx': CHART_COLORS.success,
  '3xx': CHART_COLORS.primary,
  '4xx': CHART_COLORS.warning,
  '5xx': CHART_COLORS.danger,
  default: CHART_COLORS.slate,
};

/* ---- File-type colors ---- */
export const FILETYPE_COLORS: Record<string, string> = {
  '图片':   CHART_COLORS.purple,
  '视频':   CHART_COLORS.orange,
  '音频':   CHART_COLORS.info,
  '文档':   CHART_COLORS.primary,
  '压缩包': CHART_COLORS.amber,
  '其他':   CHART_COLORS.slate,
};

/* ---- Device colors ---- */
export const DEVICE_COLORS: Record<string, string> = {
  desktop: CHART_COLORS.primary,
  mobile:  CHART_COLORS.teal,
  tablet:  CHART_COLORS.orange,
  bot:     CHART_COLORS.slate,
};

export const PERF_COLORS: Record<string, string> = {
  DNS:         CHART_COLORS.slate,
  TCP:         CHART_COLORS.info,
  TTFB:        CHART_COLORS.warning,
  'DOM Ready': CHART_COLORS.danger,
  'Page Load': CHART_COLORS.primary,
  FCP:         CHART_COLORS.success,
};

/* ---- Shared style presets ---- */
export const tooltipBase = {
  backgroundColor: 'var(--color-bg-surface, #FFFFFF)',
  borderColor: 'var(--border-default, #D5DBDB)',
  textStyle: { color: 'var(--text-primary, #16191F)', fontSize: 12 },
  extraCssText: 'border-radius: 4px; box-shadow: 0 2px 8px rgba(0,0,0,0.12);',
};

export const legendBase = {
  textStyle: { color: 'var(--text-secondary, #5F6B7A)', fontSize: 11 },
  icon: 'roundRect' as const,
  itemWidth: 10,
  itemHeight: 4,
  itemGap: 16,
};

// ============================================================
// Theme registration — dual theme (light + dark)
// ============================================================

let lightRegistered = false;
let darkRegistered = false;

/** Detect current theme from DOM */
function isDarkMode(): boolean {
  return document.documentElement.getAttribute('data-theme') === 'dark'
    || document.documentElement.getAttribute('theme-mode') === 'dark';
}

/**
 * Ensure the 'cloudscape' theme is registered (idempotent).
 * Call before echarts.init(el, 'cloudscape') in any chart component.
 */
export function ensureCyberTheme(): void {
  const dark = isDarkMode();
  if (dark && darkRegistered) return;
  if (!dark && lightRegistered) return;

  const colors = dark ? CHART_COLORS_DARK : CHART_COLORS;
  const themeName = 'cloudscape';

  echarts.registerTheme(themeName, {
    color: [
      colors.primary, colors.success, colors.warning,
      colors.danger, colors.info, colors.purple,
      colors.orange, colors.teal, colors.blue,
      colors.pink,
    ],
    backgroundColor: 'transparent',
    line: {
      itemStyle: { borderWidth: 2 },
      lineStyle: { width: 2 },
      symbolSize: 5,
      symbol: 'circle',
      smooth: false,
    },
    bar: {
      itemStyle: { borderRadius: [2, 2, 0, 0], borderWidth: 0 },
      barWidth: '55%',
    },
    pie: {
      itemStyle: { borderWidth: 2, borderColor: dark ? '#1F242B' : '#FFFFFF' },
    },
    categoryAxis: {
      axisLine: { lineStyle: { color: dark ? 'rgba(232,237,245,0.12)' : 'rgba(22,25,31,0.12)' } },
      axisTick: { show: false },
      axisLabel: { color: dark ? '#8895A7' : '#5F6B7A', fontSize: 11 },
      splitLine: { show: false },
    },
    valueAxis: {
      axisLine: { lineStyle: { color: dark ? 'rgba(232,237,245,0.12)' : 'rgba(22,25,31,0.12)' } },
      axisTick: { show: false },
      axisLabel: { color: dark ? '#8895A7' : '#5F6B7A', fontSize: 11 },
      splitLine: {
        lineStyle: {
          color: dark ? 'rgba(232,237,245,0.06)' : 'rgba(22,25,31,0.06)',
          type: 'dashed',
        },
      },
    },
    tooltip: {
      backgroundColor: dark ? 'rgba(31, 36, 43, 0.96)' : 'rgba(255, 255, 255, 0.98)',
      borderColor: dark ? 'rgba(83, 159, 229, 0.25)' : 'rgba(9, 114, 211, 0.2)',
      borderWidth: 1,
      textStyle: { color: dark ? '#E8EDF5' : '#16191F', fontSize: 12 },
      extraCssText: 'border-radius: 4px; box-shadow: 0 4px 16px rgba(0,0,0,0.15);',
    },
  });

  // Also register as 'cyber' for backward compat with existing init calls
  echarts.registerTheme('cyber', {
    color: [
      colors.primary, colors.success, colors.warning,
      colors.danger, colors.info, colors.purple,
      colors.orange, colors.teal, colors.blue,
      colors.pink,
    ],
    backgroundColor: 'transparent',
    line: { itemStyle: { borderWidth: 2 }, lineStyle: { width: 2 }, symbolSize: 5, symbol: 'circle', smooth: false },
    bar: { itemStyle: { borderRadius: [2, 2, 0, 0], borderWidth: 0 }, barWidth: '55%' },
    pie: { itemStyle: { borderWidth: 2, borderColor: dark ? '#1F242B' : '#FFFFFF' } },
    categoryAxis: {
      axisLine: { lineStyle: { color: dark ? 'rgba(232,237,245,0.12)' : 'rgba(22,25,31,0.12)' } },
      axisTick: { show: false },
      axisLabel: { color: dark ? '#8895A7' : '#5F6B7A', fontSize: 11 },
      splitLine: { show: false },
    },
    valueAxis: {
      axisLine: { lineStyle: { color: dark ? 'rgba(232,237,245,0.12)' : 'rgba(22,25,31,0.12)' } },
      axisTick: { show: false },
      axisLabel: { color: dark ? '#8895A7' : '#5F6B7A', fontSize: 11 },
      splitLine: { lineStyle: { color: dark ? 'rgba(232,237,245,0.06)' : 'rgba(22,25,31,0.06)', type: 'dashed' } },
    },
    tooltip: {
      backgroundColor: dark ? 'rgba(31, 36, 43, 0.96)' : 'rgba(255, 255, 255, 0.98)',
      borderColor: dark ? 'rgba(83, 159, 229, 0.25)' : 'rgba(9, 114, 211, 0.2)',
      borderWidth: 1,
      textStyle: { color: dark ? '#E8EDF5' : '#16191F', fontSize: 12 },
      extraCssText: 'border-radius: 4px; box-shadow: 0 4px 16px rgba(0,0,0,0.15);',
    },
  });

  if (dark) darkRegistered = true;
  else lightRegistered = true;
}

/**
 * Re-register theme after theme switch. Call when data-theme changes.
 */
export function refreshChartTheme(): void {
  lightRegistered = false;
  darkRegistered = false;
  ensureCyberTheme();
}

/**
 * Create a vertical gradient for area charts.
 */
export function areaGradient(color: string, topAlpha = 0.2, bottomAlpha = 0.01) {
  const isHex6 = /^#[0-9a-f]{6}$/i.test(color);
  const top = isHex6 ? color + hexAlpha(topAlpha) : color;
  const bottom = isHex6 ? color + hexAlpha(bottomAlpha) : color;
  return new echarts.graphic.LinearGradient(0, 0, 0, 1, [
    { offset: 0, color: top },
    { offset: 1, color: bottom },
  ]);
}

function hexAlpha(a: number): string {
  const v = Math.round(Math.max(0, Math.min(1, a)) * 255);
  return v.toString(16).padStart(2, '0');
}

// Legacy export for backward compat (used in main.ts deferred init)
export function registerCyberTheme() {
  ensureCyberTheme();
}
