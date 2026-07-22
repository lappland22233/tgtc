import { createApp } from 'vue';
import { createPinia } from 'pinia';
import App from './App.vue';
import router from './router';
import { setupRoutePrefetch } from './composables/useRoutePrefetch';
import TIcon from './components/TIcon.vue';
import 'tdesign-vue-next/dist/tdesign.css';
import './assets/styles.css';

// 启用 TDesign 深色模式（设置 DOM 属性触发 CSS 变量）
document.documentElement.setAttribute('theme-mode', 'dark');

// 延迟加载非关键模块（echarts 主题注册、遥测初始化）
let deferredInitDone = false;

// 全局错误处理：在 mount 之前同步安装，避免首屏错误漏报。
// 遥测模块（captureVueError）为延迟加载，加载完成前先缓冲错误，加载后统一转发。
let captureVueErrorFn: ((err: unknown, info: string) => void) | null = null;
const pendingVueErrors: { err: unknown; info: string }[] = [];

async function deferredInit() {
  if (deferredInitDone) return;
  deferredInitDone = true;

  // echarts 主题 — 动态导入，tree-shaken 后 ~350KB，不阻塞首屏
  const { registerCyberTheme } = await import('./utils/echarts-theme');
  registerCyberTheme();

  // 遥测 — 延迟到页面可交互后初始化（合并为单次动态导入）
  const { initTelemetry, setupRouteTracking, captureVueError } = await import('./utils/telemetry');
  initTelemetry();
  setupRouteTracking(router);

  // 启用 Vue 错误上报，并转发此前缓冲的首屏错误
  captureVueErrorFn = captureVueError;
  for (const { err, info } of pendingVueErrors) {
    captureVueErrorFn(err, info);
  }
  pendingVueErrors.length = 0;
}

const app = createApp(App);
const pinia = createPinia();

app.use(pinia);
app.use(router);

// 全局注册图标组件：<t-icon name="..."> 统一由此组件按名称映射到 TDesign 图标
app.component('TIcon', TIcon);

// 在 mount 之前同步安装全局错误处理器，确保首屏渲染错误也能被捕获
app.config.errorHandler = (err, _instance, info) => {
  console.error('[Vue Error]', err);
  console.error('Info:', info);
  if (captureVueErrorFn) {
    captureVueErrorFn(err, info);
  } else {
    // 遥测尚未就绪：缓冲，待加载后转发
    pendingVueErrors.push({ err, info });
  }
};

app.mount('#app');

// 路由级预载：根据当前路由在空闲时预加载相邻路由 chunk
setupRoutePrefetch(router);

// 首屏渲染完成后，延迟加载非关键模块
// 使用 requestIdleCallback 避免阻塞用户交互
if (typeof requestIdleCallback !== 'undefined') {
  requestIdleCallback(() => deferredInit(), { timeout: 3000 });
} else {
  setTimeout(() => deferredInit(), 200);
}
