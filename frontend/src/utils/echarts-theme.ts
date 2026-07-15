// ============================================================
// Cyber-Secure ECharts Theme — unified chart color system
// Uses dynamic import to avoid bundling echarts into main chunk
// ============================================================

import type * as echartsNS from 'echarts';

/* ---- Color Palette (static, no echarts dependency) ---- */
export const CHART_COLORS = {
  blue:       '#4D7CFE',
  cyan:       '#00E5FF',
  indigo:     '#7B6CF6',
  violet:     '#A855F7',
  success:    '#22C55E',
  warning:    '#F59E0B',
  danger:     '#EF4444',
  info:       '#38BDF8',
  amber:      '#F97316',
  pink:       '#EC4899',
  teal:       '#14B8A6',
  lime:       '#84CC16',
  slate:      '#64748B',
  rose:       '#F43F5E',
  sky:        '#0EA5E9',
  emerald:    '#10B981',
} as const;

/* ---- Status-code colors ---- */
export const STATUS_COLORS: Record<string, string> = {
  '2xx': CHART_COLORS.success,
  '3xx': CHART_COLORS.warning,
  '4xx': CHART_COLORS.danger,
  '5xx': '#881337',
  default: CHART_COLORS.slate,
};

/* ---- File-type colors ---- */
export const FILETYPE_COLORS: Record<string, string> = {
  '图片':   CHART_COLORS.blue,
  '视频':   CHART_COLORS.danger,
  '音频':   CHART_COLORS.violet,
  '文档':   CHART_COLORS.success,
  '压缩包': CHART_COLORS.amber,
  '其他':   CHART_COLORS.slate,
};

/* ---- Device colors ---- */
export const DEVICE_COLORS: Record<string, string> = {
  desktop: CHART_COLORS.teal,
  mobile:  CHART_COLORS.blue,
  tablet:  CHART_COLORS.amber,
  bot:     CHART_COLORS.violet,
};

export const PERF_COLORS: Record<string, string> = {
  DNS:       CHART_COLORS.slate,
  TCP:       CHART_COLORS.indigo,
  TTFB:      CHART_COLORS.warning,
  'DOM Ready': CHART_COLORS.danger,
  'Page Load': CHART_COLORS.success,
  FCP:       CHART_COLORS.violet,
};

/* ---- Shared style presets (static) ---- */
export const tooltipBase = {
  backgroundColor: 'rgba(17, 24, 39, 0.95)',
  borderColor: 'rgba(77, 124, 254, 0.30)',
  textStyle: { color: '#E8EDF5', fontSize: 12 },
  extraCssText: 'border-radius: 10px; box-shadow: 0 8px 32px rgba(0,0,0,0.6);',
};

export const legendBase = {
  textStyle: { color: '#8895A7', fontSize: 11, fontFamily: "'Noto Sans SC', sans-serif" },
  icon: 'roundRect' as const,
  itemWidth: 10,
  itemHeight: 4,
  itemGap: 16,
};

// ============================================================
// Lazy echarts loading (dynamic import, NOT in main bundle)
// ============================================================
let echartsModule: typeof echartsNS | null = null;

async function getEcharts(): Promise<typeof echartsNS> {
  if (!echartsModule) {
    echartsModule = await import('echarts');
  }
  return echartsModule;
}

let themeRegistered = false;

/**
 * Ensure the 'cyber' theme is registered (idempotent).
 * Call before echarts.init(el, 'cyber') in any chart component.
 */
export async function ensureCyberTheme(): Promise<void> {
  if (themeRegistered) return;
  const echarts = await getEcharts();
  echarts.registerTheme('cyber', {
    color: [
      CHART_COLORS.blue, CHART_COLORS.cyan, CHART_COLORS.success,
      CHART_COLORS.warning, CHART_COLORS.danger, CHART_COLORS.violet,
      CHART_COLORS.indigo, CHART_COLORS.amber, CHART_COLORS.teal,
      CHART_COLORS.pink,
    ],
    backgroundColor: 'transparent',
    line: {
      itemStyle: { borderWidth: 2 },
      lineStyle: { width: 2 },
      symbolSize: 6,
      symbol: 'circle',
      smooth: true,
    },
    bar: {
      itemStyle: { barBorderRadius: [4, 4, 0, 0], borderWidth: 0 },
      barWidth: '60%',
    },
    pie: {
      itemStyle: { borderWidth: 2, borderColor: '#0A0E17' },
    },
    categoryAxis: {
      axisLine: { lineStyle: { color: 'rgba(255,255,255,0.06)' } },
      axisTick: { show: false },
      axisLabel: { color: '#8895A7', fontSize: 11 },
      splitLine: { show: false },
    },
    valueAxis: {
      axisLine: { lineStyle: { color: 'rgba(255,255,255,0.06)' } },
      axisTick: { show: false },
      axisLabel: { color: '#8895A7', fontSize: 11 },
      splitLine: { lineStyle: { color: 'rgba(255,255,255,0.04)', type: 'dashed' } },
    },
    tooltip: {
      backgroundColor: 'rgba(17, 24, 39, 0.96)',
      borderColor: 'rgba(77, 124, 254, 0.25)',
      borderWidth: 1,
      textStyle: { color: '#E8EDF5', fontSize: 12 },
      extraCssText: 'border-radius: 10px; box-shadow: 0 8px 24px rgba(0,0,0,0.6); backdrop-filter: blur(8px);',
    },
  });
  themeRegistered = true;
}

/**
 * Create a vertical gradient for area charts.
 * Must be called AFTER ensureCyberTheme() to ensure echarts is loaded.
 */
export function areaGradient(color: string, topAlpha = 0.25, bottomAlpha = 0.01) {
  if (!echartsModule) throw new Error('areaGradient: call ensureCyberTheme() first');
  return new echartsModule.graphic.LinearGradient(0, 0, 0, 1, [
    { offset: 0, color: color + hexAlpha(topAlpha) },
    { offset: 1, color: color + hexAlpha(bottomAlpha) },
  ]);
}

function hexAlpha(a: number): string {
  const v = Math.round(Math.max(0, Math.min(1, a)) * 255);
  return v.toString(16).padStart(2, '0');
}

// Legacy export: registerCyberTheme() for backward compat (used in main.ts deferred init)
export async function registerCyberTheme() {
  await ensureCyberTheme();
}
