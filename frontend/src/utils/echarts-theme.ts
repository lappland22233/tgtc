// ============================================================
// Cyber-Secure ECharts Theme — unified chart color system
// ============================================================
import * as echarts from 'echarts';

/* ---- Color Palette ---- */
export const CHART_COLORS = {
  /* Primary sequential */
  blue:       '#4D7CFE',
  cyan:       '#00E5FF',
  indigo:     '#7B6CF6',
  violet:     '#A855F7',

  /* Semantic */
  success:    '#22C55E',
  warning:    '#F59E0B',
  danger:     '#EF4444',
  info:       '#38BDF8',

  /* Extended */
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
  '2xx':       CHART_COLORS.success,
  '3xx':       CHART_COLORS.warning,
  '4xx':       CHART_COLORS.danger,
  '5xx':       '#881337',
  default:     CHART_COLORS.slate,
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

/* ---- Perf stage colors ---- */
export const PERF_COLORS: Record<string, string> = {
  DNS:       CHART_COLORS.slate,
  TCP:       CHART_COLORS.indigo,
  TTFB:      CHART_COLORS.warning,
  'DOM Ready': CHART_COLORS.danger,
  'Page Load': CHART_COLORS.success,
  FCP:       CHART_COLORS.violet,
};

/**
 * Create a vertical gradient for area charts.
 */
export function areaGradient(color: string, topAlpha = 0.25, bottomAlpha = 0.01) {
  return new echarts.graphic.LinearGradient(0, 0, 0, 1, [
    { offset: 0, color: color + hexAlpha(topAlpha) },
    { offset: 1, color: color + hexAlpha(bottomAlpha) },
  ]);
}

function hexAlpha(a: number): string {
  const v = Math.round(Math.max(0, Math.min(1, a)) * 255);
  return v.toString(16).padStart(2, '0');
}

/* ---- Default tooltip style ---- */
export const tooltipBase = {
  backgroundColor: 'rgba(17, 24, 39, 0.95)',
  borderColor: 'rgba(77, 124, 254, 0.30)',
  textStyle: { color: '#E8EDF5', fontSize: 12 },
  extraCssText: 'border-radius: 10px; box-shadow: 0 8px 32px rgba(0,0,0,0.6);',
};

/* ---- Default axis style ---- */
export const axisBase = {
  axisLine: { lineStyle: { color: 'rgba(255,255,255,0.08)' } },
  axisTick: { show: false },
  axisLabel: { color: '#8895A7', fontSize: 11, fontFamily: "'JetBrains Mono', monospace" },
  splitLine: { lineStyle: { color: 'rgba(255,255,255,0.04)', type: 'dashed' as const } },
};

/* ---- Default legend style ---- */
export const legendBase = {
  textStyle: { color: '#8895A7', fontSize: 11, fontFamily: "'Noto Sans SC', sans-serif" },
  icon: 'roundRect' as const,
  itemWidth: 10,
  itemHeight: 4,
  itemGap: 16,
};

/* ---- Pie defaults ---- */
export const pieBase = {
  radius: ['45%', '75%'] as [string, string],
  center: ['40%', '50%'] as [string, string],
  label: { show: false },
  emphasis: {
    label: { show: true, fontSize: 14, fontWeight: 'bold' as const },
    itemStyle: { shadowBlur: 20, shadowColor: 'rgba(0,0,0,0.4)' },
  },
};

// ============================================================
// Register the custom theme globally
// ============================================================
export function registerCyberTheme() {
  echarts.registerTheme('cyber', {
    color: [
      CHART_COLORS.blue,
      CHART_COLORS.cyan,
      CHART_COLORS.success,
      CHART_COLORS.warning,
      CHART_COLORS.danger,
      CHART_COLORS.violet,
      CHART_COLORS.indigo,
      CHART_COLORS.amber,
      CHART_COLORS.teal,
      CHART_COLORS.pink,
    ],
    backgroundColor: 'transparent',
    textStyle: {},
    title: {},
    // Line
    line: {
      itemStyle: { borderWidth: 2 },
      lineStyle: { width: 2 },
      symbolSize: 6,
      symbol: 'circle',
      smooth: true,
    },
    // Bar
    bar: {
      itemStyle: {
        barBorderRadius: [4, 4, 0, 0],
        borderWidth: 0,
      },
      barWidth: '60%',
    },
    // Pie
    pie: {
      itemStyle: {
        borderWidth: 2,
        borderColor: '#0A0E17',
      },
    },
    // Scatter
    scatter: {
      itemStyle: { borderWidth: 0 },
    },
    // Category axis
    categoryAxis: {
      axisLine: { lineStyle: { color: 'rgba(255,255,255,0.06)' } },
      axisTick: { show: false },
      axisLabel: { color: '#8895A7', fontSize: 11 },
      splitLine: { show: false },
    },
    // Value axis
    valueAxis: {
      axisLine: { lineStyle: { color: 'rgba(255,255,255,0.06)' } },
      axisTick: { show: false },
      axisLabel: { color: '#8895A7', fontSize: 11 },
      splitLine: { lineStyle: { color: 'rgba(255,255,255,0.04)', type: 'dashed' } },
    },
    // Grid lines
    logAxis: {
      splitLine: { lineStyle: { color: 'rgba(255,255,255,0.04)', type: 'dashed' } },
    },
    timeAxis: {
      splitLine: { lineStyle: { color: 'rgba(255,255,255,0.04)', type: 'dashed' } },
    },
    toolbox: {},
    legend: {},
    tooltip: {
      backgroundColor: 'rgba(17, 24, 39, 0.96)',
      borderColor: 'rgba(77, 124, 254, 0.25)',
      borderWidth: 1,
      textStyle: { color: '#E8EDF5', fontSize: 12 },
      extraCssText: 'border-radius: 10px; box-shadow: 0 8px 24px rgba(0,0,0,0.6); backdrop-filter: blur(8px);',
    },
    dataZoom: {
      dataBackgroundColor: 'rgba(0,0,0,0.15)',
      selectedDataBackgroundColor: 'rgba(77, 124, 254, 0.15)',
    },
    markPoint: {
      label: { color: '#E8EDF5' },
    },
  });
}
