import { createApp } from 'vue';
import { createPinia } from 'pinia';
import TDesign from 'tdesign-vue-next';
import App from './App.vue';
import router from './router';
import { initTelemetry, captureVueError, setupRouteTracking } from './utils/telemetry';
import { registerCyberTheme } from './utils/echarts-theme';
import 'tdesign-vue-next/dist/tdesign.css';
import './assets/styles.css';

// 注册 ECharts 自定义主题（在所有图表 init 之前）
registerCyberTheme();

// 启用 TDesign 深色模式（设置 DOM 属性触发 CSS 变量）
document.documentElement.setAttribute('theme-mode', 'dark');

const app = createApp(App);
const pinia = createPinia();

app.use(pinia);
app.use(router);
app.use(TDesign);

// 全局错误边界：捕获未处理的组件错误，同时上报遥测
app.config.errorHandler = (err, _instance, info) => {
  console.error('[Vue Error]', err);
  console.error('Info:', info);
  captureVueError(err, info);
};

app.mount('#app');

// 应用挂载后初始化遥测（错误/性能/环境信息自动上报）
initTelemetry();
// 注册路由切换追踪（SPA 导航性能 + 后续行为追踪）
setupRouteTracking(router);
