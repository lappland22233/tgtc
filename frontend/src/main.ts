import { createApp } from 'vue';
import { createPinia } from 'pinia';
import TDesign from 'tdesign-vue-next';
import App from './App.vue';
import router from './router';
import 'tdesign-vue-next/dist/tdesign.css';
import './assets/styles.css';

// 启用 TDesign 深色模式（设置 DOM 属性触发 CSS 变量）
document.documentElement.setAttribute('theme-mode', 'dark');

// 延迟加载非关键模块（echarts 主题注册、遥测初始化）
let deferredInitDone = false;
async function deferredInit() {
  if (deferredInitDone) return;
  deferredInitDone = true;

  // echarts 主题 — 动态导入，避免 ~1MB 阻塞首屏
  const { registerCyberTheme } = await import('./utils/echarts-theme');
  registerCyberTheme();

  // 遥测 — 延迟到页面可交互后初始化
  const { initTelemetry, setupRouteTracking } = await import('./utils/telemetry');
  initTelemetry();
  setupRouteTracking(router);

  // 全局错误处理
  const { captureVueError } = await import('./utils/telemetry');
  app.config.errorHandler = (err, _instance, info) => {
    console.error('[Vue Error]', err);
    console.error('Info:', info);
    captureVueError(err, info);
  };
}

const app = createApp(App);
const pinia = createPinia();

app.use(pinia);
app.use(router);
app.use(TDesign);

app.mount('#app');

// 首屏渲染完成后，延迟加载非关键模块
// 使用 requestIdleCallback 避免阻塞用户交互
if (typeof requestIdleCallback !== 'undefined') {
  requestIdleCallback(() => deferredInit(), { timeout: 3000 });
} else {
  setTimeout(() => deferredInit(), 200);
}
