// ============================================================
// Centralized ECharts module — tree-shaken entry point
//
// Only imports the chart types, components, and renderer that
// the project actually uses, instead of the full `echarts` barrel.
// This reduces the echarts bundle from ~1 MB to ~350 kB.
//
// Usage in page components:
//   import { init } from '@/utils/echarts';
//   import type { ECharts } from '@/utils/echarts';
//
// The 'cyber' theme is registered separately via ensureCyberTheme()
// in echarts-theme.ts (called lazily from main.ts).
// ============================================================

import * as echarts from 'echarts/core';

import { LineChart, BarChart, PieChart } from 'echarts/charts';
import {
  TooltipComponent,
  LegendComponent,
  GridComponent,
} from 'echarts/components';
import { CanvasRenderer } from 'echarts/renderers';

// Register only what we need — enables tree-shaking of the rest.
// 注意：新增图表/组件类型（如 GaugeChart、DataZoomComponent）时必须在此同步注册，
// 否则对应 series/component 不会被打包，运行时静默不渲染。
echarts.use([
  LineChart,
  BarChart,
  PieChart,
  TooltipComponent,
  LegendComponent,
  GridComponent,
  CanvasRenderer,
]);

// Re-export with full type signatures (re-export, not destructuring, to preserve overloads)
export { init, registerTheme, graphic, getInstanceByDom, dispose } from 'echarts/core';
// v6 实例类型规范名为 EChartsType；保留 ECharts 别名兼容现有 `echarts.ECharts` 用法
export type { EChartsType, EChartsType as ECharts } from 'echarts/core';
export default echarts;
