# FileCloud 前端样式开发规范

> TGTC 青绿工作台 · 浅色 / 深色 / 跟随系统三态主题 + Tailwind v4 分层架构
> 适用于本项目所有前端页面的新增与修改

---

## 1. 核心原则

1. **禁止硬编码颜色** — 所有颜色必须通过 CSS 变量或 Tailwind 语义工具类引用，不允许在 SFC 或样式中出现 `#xxx`、`rgb()`、`rgba()` 字面量（`tokens.css` / `critical.css` / `echarts-theme.ts` / `TagManager.vue` 预设色板 / `useTheme.ts` 兜底值除外）。
2. **禁止静态内联 `style="..."`** — 静态样式一律迁移到组件 `<style scoped>`、全局 `primitives.css` 或 Tailwind 工具类；仅允许动态数据驱动的 `:style="{ ... }"`（如标签色 `--file-tag-color`、树层级 `--directory-depth`）。
3. **禁止 Emoji 充当图标** — 所有图标使用 `FileTypeIcon` 组件或内联 SVG（`stroke-width="1.5"`、`currentColor`、`viewBox="0 0 24 24"`）。
4. **禁止 `!important`** — 通过 `html .t-*` 未分层规则或组合选择器提升优先级覆盖 TDesign；唯一例外是 `base.css` 中的 `@media (prefers-reduced-motion: reduce)`。
5. **移动优先（Mobile-first）** — 基础样式默认服务 ≤480px 窄屏，统一通过 `@media (min-width: ...)` 逐级增强；禁止 `@media (max-width: ...)`。
6. **强制组件级样式隔离** — `.vue` 文件统一使用 `<style scoped>`，禁止新增未加 `scoped` 的 `<style>` 块。
7. **门禁即规范** — 提交前运行 `npm run check:style` 校验上述约束。

---

## 2. CSS 分层与文件架构

全局样式模块化拆分在 `src/assets/styles/`，由 `src/assets/styles/index.css` 按精确层叠顺序引入：

```
src/assets/styles/
├── index.css        # 唯一全局入口（按层叠顺序导入以下模块）
├── tokens.css       # @theme 断点/字体/圆角/语义色映射 + Light(:root) / Dark([data-theme="dark"]) 令牌
├── base.css         # @layer base 全局 reset、滚动条、focus-visible 与 reduced-motion 保护
├── tdesign.css      # 未分层 html .t-* 覆写（自然高于 @layer base/components，无需 !important）
├── primitives.css   # @layer components 移动优先通用原语（.card、.metrics-grid、.mobile-card* 等）
├── animations.css   # 关键帧动画与过渡工具类
└── critical.css     # 首屏防闪烁关键样式
```

> [!IMPORTANT]
> **Tailwind v4 与 TDesign 级联隔离规则**：`@layer utilities` 位于末位，可覆盖 `@layer base/components`，但无法直接覆盖未分层的 `tdesign-vue-next` `.t-*` 规则。因此 **禁止将控制宽度/边距的工具类直接挂在 `<t-select>`、`<t-input>`、`<t-input-number>`、`<t-button>` 上**，应使用外层容器 `<div class="...">` 包裹或写入 `<style scoped>` 的 `:deep(.t-*)`。
>
> **表单标签约定**：`<t-form>` 一律使用 `label-align="top"`。TDesign 的 `layout="vertical"` 仍默认左浮动 `100px` `label-width` 且 `white-space: nowrap`，长标签（或 `label-width="0"`）会直接与右侧控件按钮重叠。

---

## 3. 设计令牌体系（`src/assets/styles/tokens.css`）

### 3.1 工作台核心与语义令牌

| 令牌 | 浅色 (`:root`) | 深色 (`[data-theme="dark"]`) | 用途 | Tailwind 语义类示例 |
|------|----------------|------------------------------|------|---------------------|
| `--workspace-canvas` / `--seed-bg` | `#F6F5EF` | `#1B211E` | 页面画布底色 | `bg-canvas` |
| `--workspace-surface` / `--seed-surface` | `#FFFEFA` | `#242927` | 卡片/面板表面 | `bg-surface` |
| `--color-bg-elevated` | `color-mix(...)` | `color-mix(...)` | 抬升表面/表头/次级区 | `bg-elevated` |
| `--color-bg-overlay` | `color-mix(...)` | `color-mix(...)` | 弹窗输入框/浮层表面 | `bg-overlay` |
| `--workspace-selected` | `#E6F2EB` | `#223D35` | 选中与高亮底色 | `bg-selected` |
| `--workspace-accent` / `--seed-primary` | `#006B5B` | `#65DCC5` | 主品牌操作色 | `text-brand` / `bg-brand` |
| `--workspace-on-accent` | `#FFFFFF` | `#102C25` | 实色主按钮文字 | `text-on-brand` |
| `--text-primary` / `--workspace-text` | `#202923` | `#EDF2EE` | 主文本 | `text-ink` |
| `--text-secondary` / `--workspace-muted` | `#59645E` | `#B2BEB7` | 次要文本 | `text-ink-muted` |
| `--text-tertiary` / `--text-quaternary` | `color-mix(...)` | `color-mix(...)` | 辅助/弱提示文本 | `text-ink-subtle` |
| `--border-default` / `--border-strong` | `#E3E6DF` / `22%` | `#3A463E` / `22%` | 常规/强调边框 | `border-line` |
| `--color-success` / `--color-warning` / `--color-danger` / `--color-info` | `#037F0C` 等 | `#53D769` 等 | 状态语义色与 `-soft` 浅底 | `text-ok` / `text-warn` / `text-err` |

### 3.2 媒体舞台令牌（Media Stage Tokens）

播放器与媒体预览浮层（`CustomVideoPlayer`、`MiniMediaPlayer`、`FilePreviewDialog`、`PreviewHeader`）统一消费 `--media-*` 影院深色令牌，保证浅色与深色主题下控制栏、进度条与海报遮罩均有稳定对比度：

- 画布与表面：`--media-backdrop`、`--media-stage-bg`、`--media-surface`、`--media-surface-hover`、`--media-surface-elevated`、`--media-surface-tooltip`
- 遮罩层：`--media-scrim`、`--media-scrim-mid`、`--media-scrim-soft`
- 文本与控件：`--media-text`、`--media-text-primary`、`--media-text-secondary`、`--media-text-muted`、`--media-text-faint`
- 轨道与边框：`--media-track`、`--media-buffered`、`--media-hover`、`--media-border`、`--media-border-subtle`、`--media-shadow`、`--media-thumb-*`

### 3.3 文件类型色、圆角与间距

- **文件类型色**：`--file-color-image`、`--file-color-video`、`--file-color-audio`、`--file-color-pdf`、`--file-color-word`、`--file-color-excel`、`--file-color-ppt`、`--file-color-archive`、`--file-color-code`、`--file-color-folder`（Light/Dark 自动切换）。
- **圆角**：`--radius-sm` (4px)、`--radius-md` (8px)、`--radius-lg` (12px)、`--radius-xl` (16px)。
- **间距与字体**：`--space-1` ~ `--space-8`（4px/8px 节律）；`--font-display`、`--font-body`、`--font-mono`（系统字体栈优先，禁止引入外站字体）。

---

## 4. 三态主题切换体系（`useTheme` & `ThemeToggle`）

- 核心逻辑在 [`src/composables/useTheme.ts`](src/composables/useTheme.ts)：
  - 偏好状态 `ThemePreference = 'light' | 'dark' | 'system'`，`localStorage` 键名固定为 `filecloud-theme`（`'system'` 时清除键，实时监听 `(prefers-color-scheme: dark)`）。
  - 同时维护 `html[data-theme="light" | "dark"]` 与 `html[theme-mode="dark"]`（同步 TDesign 暗色模式）、`<meta name="theme-color">`，并自动调用 `refreshChartTheme()`。
- UI 组件 [`src/components/ThemeToggle.vue`](src/components/ThemeToggle.vue)：
  - `variant="icon"`：头部快捷图标按钮（`cycleTheme`）。
  - `variant="segmented"`：用户设置页三态分段控制器（浅色 / 深色 / 跟随系统）。

---

## 5. 移动优先响应式断点

`tokens.css`（`@theme`）、`primitives.css` 与 `src/composables/useMobile.ts` 使用完全对齐的 5 级断点：

| 断点名 | CSS 媒体查询（移动优先） | JS (`useBreakpoint()`) | 布局策略 |
|--------|--------------------------|------------------------|----------|
| `xs`（基线） | 默认样式（0–480px） | `<= 480px` (`isPhone`) | 单列流式、表格转 `.mobile-card`、紧凑按钮 |
| `sm` | `@media (min-width: 481px)` | `481–768px` (`isTablet`) | 双列统计卡、中等控件展开 |
| `md` | `@media (min-width: 769px)` | `> 768px` (`!isMobile`) | 切换桌面表格、多栏筛选栏与网格布局 |
| `lg` | `@media (min-width: 1024px)` | `>= 1024px` (`isRailInline`) | 侧边目录树/详情侧栏内联常驻显示 |
| `xl` | `@media (min-width: 1441px)` | `> 1440px` | 宽屏阅读限宽优化 |

触控无障碍：使用 `@media (pointer: coarse)` 保证可点击控件最小命中区 `44px × 44px`；表格在 ≤768px 需提供卡片替代视图。

---

## 6. ECharts 图表规范（`src/utils/echarts-theme.ts`）

- 图表统一通过 `getThemeChartColors()`、`getTooltipBase()`、`getLegendBase()`、`ensureCyberTheme()`、`refreshChartTheme()` 读取当前主题配色（包含 `palette`、`surface`、`text`、`muted`、`border`、`axisLabel`、`axisLine`、`splitLine`、`emptySlice`、`emphasisShadow`）。
- 必须在组件中监听 `useTheme().resolvedTheme`（或使用主题工具函数）在切换主题后调用 `refreshChartTheme()` 并重绘图表。
- 禁止在业务视图中手动判断 `[data-theme="dark"]` 或编写 `#8895A7` / `rgba(...)` 硬编码轴线颜色。

---

## 7. 管理后台共用组件与模块化拆分

- 共用管理原语（`src/components/admin/`）：
  - `AdminMetricCard.vue`、`AdminFilterBar.vue`、`AdminChartCard.vue`、`AdminMobileCard.vue`、`FormFieldHint.vue`
- 复杂页面按功能域拆分子组件：
  - 系统配置：`src/components/admin/config/*`（`ConfigSiteSection`、`ConfigAuthSmtpSection`、`ConfigUploadSection`、`ConfigCacheDownloadSection`、`ConfigBotSection`、`ConfigIpBanSection`）
  - Telegram 账号：`src/components/admin/telegram/*` 与 `src/utils/telegram-format.ts`

---

## 8. 样式质量门禁（`npm run check:style`）

运行 `npm run check:style`（[`scripts/check-style-hygiene.mjs`](scripts/check-style-hygiene.mjs)）自动检查并阻断以下违规：

1. 静态内联 `style="..."` 属性
2. 白名单外的 `#hex` / `rgb()` / `rgba()` 硬编码颜色
3. `tdesign.css` 之外直接使用 `--td-*` 变量，或引用未在 `tokens.css` / 组件内定义的 CSS 变量
4. `base.css` `prefers-reduced-motion` 之外的 `!important`
5. 未添加 `scoped` / `module` 的 `<style>` 块
6. `@media (max-width: ...)` 或未对齐历史断点（`360/500/680/700/720/960px`）
7. 重新引入已清理的废弃文件/符号（`Upload.vue`、`FileCard.vue`、`FolderCard.vue`、`getFileEmoji` 等）
8. 未使用 `label-align="top"` 的 `<t-form layout="vertical">` / `label-width="0"`（防止表单标签与按钮/开关重叠）

---

## 9. 禁止事项汇总

| 禁止 | 替代方案 |
|------|----------|
| 硬编码颜色值 | `tokens.css` 语义变量或 `@theme` 工具类 |
| 静态 `style="..."` | Tailwind 工具类或 `<style scoped>` 类名 |
| Emoji 图标 | `FileTypeIcon` / 内联 1.5px 描边 SVG |
| `!important` | `html .t-*` 未分层覆盖或组合选择器 |
| `@media (max-width: ...)` | `@media (min-width: 481px / 769px / 1024px / 1441px)` |
| 直接消费 `--td-*` | 映射到 `--color-*` / `--text-*` / `--border-*` |
| 图表内联 DOM 暗色检测 | `useTheme()` + `getThemeChartColors()` |

---

## 10. 新增/修改页面自检清单

- [ ] 通过 `npm run check:style` 与 `npm run typecheck`
- [ ] Light / Dark / System 三态主题与 `--media-*` / 图表均随主题即时同步
- [ ] 320px / 480px / 768px / 1024px / 1440px 断点无溢出、表格有移动端卡片替代
- [ ] 触控控件在 `@media (pointer: coarse)` 下满足 `44px` 最小交互区，装饰 SVG 带 `aria-hidden="true"`

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
