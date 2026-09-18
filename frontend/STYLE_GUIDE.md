# FileCloud 前端样式开发规范

> 基于 Cloudscape 设计语言 · Seed Token 架构 · Light/Dark 双主题
> 适用于本项目所有前端页面的新增与修改

---

## 1. 核心原则

1. **禁止硬编码颜色** — 所有颜色必须通过 CSS 变量引用，不允许在 scoped style 或内联样式中出现 `#xxx`、`rgb()`、`rgba()` 字面量（图表主题辅助函数除外，见第 6 节）。
2. **禁止 Emoji 充当图标** — 所有图标使用 `FileTypeIcon` 组件或内联 SVG（1.5px 描边、`currentColor`、`viewBox="0 0 24 24"`）。
3. **禁止 `!important`** — 通过 `html .t-*` 选择器提升优先级覆盖 TDesign，新增样式不得引入 `!important`。
4. **移动优先** — 样式默认服务窄屏，通过 `min-width` 媒体查询逐级增强。
5. **双主题兼容** — 任何新增样式必须在 Light 和 Dark 下都正常显示，通过切换 `data-theme` 验证。

---

## 2. Seed Token 体系

### 2.1 种子令牌（仅 6 个，主题切换只改这层）

| 令牌 | Light | Dark | 用途 |
|------|-------|------|------|
| `--seed-bg` | `#F2F3F3` | `#16191F` | 页面背景 |
| `--seed-fg` | `#16191F` | `#E8EDF5` | 主文本 |
| `--seed-primary` | `#0972D3` | `#539FE5` | 主操作色 |
| `--seed-accent` | `#033160` | `#7DBBEE` | 强调/悬停 |
| `--seed-surface` | `#FFFFFF` | `#1F242B` | 容器表面 |
| `--seed-radius` | `4px` | `4px` | 基础圆角 |

### 2.2 语义令牌（组件中直接使用的层）

```css
/* 背景 */
var(--color-bg)              /* 页面底色 */
var(--color-bg-elevated)     /* 抬升区域（侧边栏、表头） */
var(--color-bg-surface)      /* 卡片/容器表面 */
var(--color-bg-overlay)      /* 弹窗内输入框底色 */
var(--color-bg-hover)        /* 悬停背景 */
var(--color-bg-selected)     /* 选中/激活背景 */

/* 文本 */
var(--text-primary)          /* 主文本 */
var(--text-secondary)        /* 次要文本（62% 混合） */
var(--text-tertiary)         /* 辅助文本（42% 混合） */
var(--text-disabled)         /* 禁用文本 */

/* 边框 */
var(--border-default)        /* 常规边框（12% 混合） */
var(--border-strong)         /* 强调边框（22% 混合） */
var(--border-accent)         /* 主色边框（35% 主色） */

/* 语义色 */
var(--color-success)  var(--color-success-soft)
var(--color-warning)  var(--color-warning-soft)
var(--color-danger)   var(--color-danger-soft)

/* 阴影 */
var(--shadow-sm)  var(--shadow-md)  var(--shadow-lg)
```

### 2.3 间距与圆角

间距基于 **8px 基线**，允许 4px 用于密集内部对齐：

```css
var(--space-1)  /* 4px */    var(--space-2)  /* 8px */
var(--space-3)  /* 12px */   var(--space-4)  /* 16px */
var(--space-5)  /* 20px */   var(--space-6)  /* 24px */
var(--space-8)  /* 32px */
```

圆角从种子派生，保持 Cloudscape 锐利几何：

```css
var(--radius-sm)  /* 4px — 按钮/输入框/标签 */
var(--radius-md)  /* 8px — 卡片 */
var(--radius-lg)  /* 12px — 弹窗/大容器 */
var(--radius-xl)  /* 16px — 认证卡片 */
```

### 2.4 字体

系统字体栈优先，**禁止引入外部字体文件**（LCP 考量）：

```css
var(--font-body)     /* -apple-system, ..., "Noto Sans SC", "Microsoft YaHei" */
var(--font-display)  /* 同 body，标题使用 */
var(--font-mono)     /* ui-monospace, "Cascadia Code", ... */
```

字号规范：正文 14px，辅助 12px，标签 11px（大写标签需 `letter-spacing: 0.06em` 以上），标题 18-22px（`letter-spacing: -0.01em ~ -0.02em`）。

---

## 3. 主题切换规则

### 3.1 工作原理

- `main.ts` 初始化时设置 `document.documentElement[data-theme]`（优先级：localStorage `filecloud-theme` > 系统偏好 > light）
- 暗色主题仅覆盖 6 个种子令牌 + 语义色，组件样式零改动
- TDesign 通过 `theme-mode="dark"` 属性同步（App.vue MutationObserver 自动维护）

### 3.2 新增组件时的主题检查清单

- [ ] 所有颜色引用 `var(--*)` 令牌
- [ ] 在 Light 和 Dark 下分别截图验证对比度
- [ ] 文本对比度满足 WCAG AA（正文 ≥ 4.5:1，大文本 ≥ 3:1）
- [ ] 状态表达不依赖单一颜色（配合图标/文字/形状）
- [ ] 需要手动切换主题时调用 `window.__setFileCloudTheme('light' | 'dark')`

### 3.3 暗色主题注意事项

- 不使用纯黑 `#000` 或纯白 `#fff` 作为大面积背景/文本
- 暗色下阴影使用 `rgba(0,0,0,x)` 而非 `color-mix`（已在 styles.css 处理）
- 图表配色使用 `CHART_COLORS_DARK` 亮色变体

---

## 4. 响应式断点

| 断点 | 范围 | 布局策略 |
|------|------|----------|
| `xs` | ≤ 480px | 单列流式，KPI 单列，按钮全宽 |
| `sm` | 481–768px | 单/双列自适应，表格→卡片列表，侧边栏→抽屉 |
| `md` | 769–1024px | 双列网格，表格保留，侧边栏可折叠 |
| `lg` | 1025–1440px | 标准网格，侧边栏固定 240px |
| `xl` | > 1440px | 内容区限宽 1200px 居中 |

### 4.1 使用方式

```ts
// 简单场景：isMobile = ≤768px（向后兼容）
import { useMobile } from '@/composables/useMobile';
const isMobile = useMobile();

// 精细场景：五级断点
import { useBreakpoint } from '@/composables/useMobile';
const { breakpoint, isPhone, isTablet, isDesktop } = useBreakpoint();
```

### 4.2 强制规则

- 表格在 ≤768px 必须提供卡片列表替代方案
- 触控设备（`hover: none`）最小点击区域 **44px**
- 禁止横向滚动（除有意为之的数据表格）
- 文本自然换行，禁止用 `font-size` 跟随视口缩放

---

## 5. 组件使用规范

### 5.1 文件类型图标

```vue
<script setup lang="ts">
import FileTypeIcon from '@/components/FileTypeIcon.vue';
</script>

<template>
  <!-- 基础用法 -->
  <FileTypeIcon :mimeType="file.mimeType" :fileName="file.name" :size="20" />
  <!-- 带彩色背景圆（列表/卡片场景） -->
  <FileTypeIcon :mimeType="file.mimeType" :fileName="file.name" :size="40" with-bg />
</template>
```

类型判断逻辑在 `src/utils/file-icon-type.ts`，支持 MIME + 扩展名双重检测。

### 5.2 TDesign 覆盖方式

全局覆盖写在 `styles.css` 第 15 节，使用 `html .t-*` 前缀：

```css
/* 正确 ✓ */
html .t-button--theme-primary.t-button--variant-base {
  background: var(--seed-primary);
}

/* 错误 ✗ */
.t-button--theme-primary { background: #0972D3 !important; }
```

页面级 TDesign 微调写在 scoped style 中，同样只允许引用令牌。

### 5.3 弹窗规范

- 结构三区：header（标题 + 关闭）/ body（表单）/ footer（右对齐按钮：次要在前，主要在后）
- 圆角 `var(--radius-lg)`，阴影 `var(--shadow-lg)`
- 弹窗内输入框背景用 `var(--color-bg-overlay)`
- 破坏性操作（删除）使用 danger 按钮，且必须有确认步骤

### 5.4 状态展示

每个数据区域必须覆盖以下状态：

| 状态 | 实现 |
|------|------|
| 加载中 | 骨架屏（`skeleton` 动画）或 `t-loading` |
| 空数据 | 居中图标 + 说明文字 + 引导操作按钮 |
| 错误 | 错误图标 + 原因 + 重试按钮 |
| 进度 | `progress-track` + 百分比/速度/剩余时间 |

---

## 6. ECharts 图表规范

### 6.1 主题注册

```ts
import { ensureCyberTheme } from '@/utils/echarts-theme';
import echarts from '@/utils/echarts';

// init 前必须调用（幂等，自动检测当前主题）
ensureCyberTheme();
const chart = echarts.init(el, 'cloudscape'); // 'cyber' 为兼容别名
```

### 6.2 主题感知内联配色

图表 option 中需要内联颜色时，使用主题判断函数：

```ts
const isDark = () => document.documentElement.getAttribute('data-theme') === 'dark';
const axisLabelColor = () => isDark() ? '#8895A7' : '#5F6B7A';
const splitLineColor = () => isDark() ? 'rgba(232,237,245,0.06)' : 'rgba(22,25,31,0.06)';
```

### 6.3 图表可读性规则

- 坐标轴标签 11px，使用次要文本色
- 网格线虚线、低对比度（6% 透明度）
- 数据系列从 `CHART_COLORS` / `CHART_COLORS_DARK` 取色，禁止自定义 hex
- 每个图表必须附带文字摘要或图例（无障碍要求）
- tooltip 圆角 4px，跟随主题背景色
- 主题切换后需调用 `refreshChartTheme()` 并重新 init 图表实例

---

## 7. 新增页面检查清单

### 结构

- [ ] 语义化 HTML（`<aside>` / `<header>` / `<main>` / `<section>`）
- [ ] 页面标题使用 `.page-header` 全局类
- [ ] 卡片使用 `.card` 全局类，统计卡使用 `.stat-card`

### 样式

- [ ] 零硬编码颜色（grep 自检：`#[0-9a-fA-F]{3,6}` 和 `rgba?(`）
- [ ] 间距使用 `--space-*` 令牌
- [ ] 圆角使用 `--radius-*` 令牌
- [ ] 过渡动画使用 `--duration-*` 和 `--ease-out-expo`

### 交互

- [ ] 所有可交互元素有 `:hover` / `:focus-visible` / `:disabled` 状态
- [ ] 表单控件有可见 label 和错误提示
- [ ] 破坏性操作有确认步骤
- [ ] 加载/空/错误状态完整

### 响应式

- [ ] 320px 宽度下无溢出、无裁切
- [ ] 768px 以下表格切换为卡片列表
- [ ] 触控目标 ≥ 44px

### 无障碍

- [ ] 装饰性 SVG 添加 `aria-hidden="true"`
- [ ] 图标按钮添加 `aria-label`
- [ ] 状态不只用颜色表达
- [ ] 遵循 `prefers-reduced-motion`（全局已处理）

---

## 8. 禁止事项汇总

| 禁止 | 替代方案 |
|------|----------|
| 硬编码颜色值 | `var(--*)` 语义令牌 |
| Emoji 图标 | `FileTypeIcon` / 内联 SVG |
| `!important` | `html .t-*` 选择器优先级 |
| 外部字体文件 | 系统字体栈 |
| 渐变按钮/发光阴影 | 平面纯色 + 边框层次 |
| 单一 768px 断点判断 | `useBreakpoint()` 五级断点 |
| 图表自定义 hex 配色 | `CHART_COLORS` 调色板 |
| 纯黑/纯白大面积使用 | 种子令牌灰阶 |
| 虚构后端不存在的功能数据 | 对照 API 接口文档 |

---

## 9. 文件结构约定

```
src/
├── assets/styles.css          # 全局设计系统（唯一全局样式文件）
├── components/
│   ├── FileTypeIcon.vue       # 文件类型 SVG 图标组件
│   └── ...
├── composables/useMobile.ts   # useMobile() + useBreakpoint()
└── utils/
    ├── file-icon-type.ts      # getFileIconType() 类型检测
    ├── echarts-theme.ts       # 双主题图表注册
    └── format.ts              # 格式化工具（getFileEmoji 已废弃）
```

新增全局样式模式（如新的通用组件类）统一追加到 `styles.css` 对应章节，禁止新建全局 CSS 文件。

---

## 10. 设计参考

完整设计系统 Showcase 位于 Canvas 工作区 `index.html`，包含所有组件的双主题高保真参考。关键决策以该文件为准：

- 令牌定义 → 「Seed Token 体系」区块
- 组件样式 → 「组件覆盖」「弹窗、表单与导航模式」区块
- 页面模式 → 「页面交互模式」「分享与公开页面」「管理后台模式」「数据管理模式」区块
- 图表配色 → 「图表主题」区块
- 响应式 → 「响应式断点」区块

---

## 11. 下载交互规范

> 适用于所有下载入口（文件列表、预览弹窗、分享页）。后端为「两阶段下载」：
> 先创建任务（`POST /api/files/:id/download-tasks`），资源就绪后再由浏览器原生下载器接管传输。
> `downloadUrl` 就绪时**已自带一次性 `?taskTicket=`**，前端直接用返回值即可，**不要**自行拼接。

### 11.1 状态文案表

| 状态 | 文案 | 说明 |
|------|------|------|
| 排队中 `queued` | `排队中 · <原因>` | 原因取自服务端 message（等待磁盘空间 / 下载连接繁忙 / 服务器负载较高），不得只写「处理中」 |
| 已就绪 `streamable`（`mode: 'cache'`） | `已就绪 · 正在交给浏览器下载` | 资源已预留，正在把下载地址交给浏览器原生下载器 |
| 直通下载 `streamable` + `mode: 'direct'` | `直通下载 · 不占本地缓存，已开始下载` | 结构性不可行的有界直通；**不得**把它当作「永远在排队」 |
| 已开始 | `已开始下载「<文件名>」` | 触发浏览器下载后的**唯一**完成措辞 |
| 已中断 `cancelled` | `下载任务已中断` | 以服务端返回状态为准，**不做乐观置位** |
| 已过期 `expired` | `下载任务已过期，请重新发起下载` | 终态，停止轮询 |

- 文案必须逐状态区分；`mode === 'direct'` 的语义是「可立即下载」，不是「排队中」。
- 队列指示器（`DownloadQueueIndicator`）保持 `aria-live="polite"`；移动端使用卡片布局，触控目标 ≥ 44px。

### 11.2 禁止虚假完成状态

- 浏览器原生下载器**不回传完成状态**，因此只允许写「已开始下载」，**禁止**「下载成功 / 已完成 / 100%」等虚假完成态。
- 未取得真实进度时**不得**展示虚假百分比（无精确进度就不要显示 0%–100% 的进度条）。

### 11.3 禁止大文件 blob 下载

- 统一使用 `triggerBrowserDownload()`（创建 `<a download>` 交由浏览器原生下载器）。
- **禁止** `fetch + blob + URL.createObjectURL` 方案：它会把整个文件读进内存，大文件会挂起并占用大量内存。

### 11.4 直通 / 直连大文件提示

- 结构性不可行（缓存放不下）或分享域直连时，提示：
  「已开始下载。大文件建议使用支持断点续传的下载器：下载中断后可用同一链接恢复，下载地址过期后请重新获取。」
- 链接过期后必须**重新获取**下载地址；中断后复用**同一链接**恢复。

### 11.5 结构化下载错误展示优先级

下载调度错误码（`DOWNLOAD_*`）必须**优先**于通用基础设施文案展示，不能被通用 503/507 提示劫持：

| 优先级 | 场景 | 文案来源 |
|--------|------|----------|
| 1（最高） | `DOWNLOAD_QUEUE_FULL / DOWNLOAD_QUEUE_TIMEOUT / DOWNLOAD_QUEUE_CANCELLED / DOWNLOAD_SERVER_BUSY / DOWNLOAD_STORAGE_PROBE_UNAVAILABLE / DOWNLOAD_INSUFFICIENT_STORAGE / DOWNLOAD_TASK_EXPIRED / DOWNLOAD_SHUTTING_DOWN` | `utils/error.ts` 的 `DOWNLOAD_ERROR_MESSAGES` |
| 2 | 其他 507 / 磁盘业务码 | 通用「存储空间不足」 |
| 3 | 其他 502 / 503 | 通用「文件服务暂时不可用」 |

- `classifyServiceAvailabilityError()` 对 `DOWNLOAD_*` 一律返回 `null`，避免排队文案被通用故障文案覆盖（既有行为，勿回退）。

### 11.6 移动端与无进度

- ≤768px 使用卡片布局；触控目标 ≥ 44px；不给无精确进度的任务显示百分比。
