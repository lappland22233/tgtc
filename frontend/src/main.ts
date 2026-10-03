import { createApp } from 'vue';
import { createPinia } from 'pinia';
import App from './App.vue';
import router from './router';
import { setupRoutePrefetch } from './composables/useRoutePrefetch';
import { usePublicConfigStore } from './stores/public-config';
import TIcon from './components/TIcon.vue';
// PERF-F-101：TDesign 样式改为按需。
// - 基础层（:root 设计变量、theme-mode 暗色变量、reset）：组件级 CSS 不含这些内容
//   （已在 node_modules 实测：button/table 等 es/<comp>/style/index.css 中 :root 与
//   theme-mode 匹配数均为 0），因此必须单独引入 es/style/css.mjs。
// - 组件层：由 vite.config.ts 的 TDesignResolver({ importStyle: 'css' }) 按模板实际
//   使用的组件逐个注入；命令式插件（MessagePlugin / DialogPlugin）经
//   tdesign-vue-next/es/message|dialog 导入，其 index.mjs 自带 `import './style/css.mjs'`，
//   无需额外处理。
// 不再引入 dist/tdesign.css（518 KB 全量），首屏只承担实际用到的组件样式。
import 'tdesign-vue-next/es/style/css.mjs';
import './assets/styles.css';

// ---- Theme initialization (Light/Dark dual theme) ----
// Priority: localStorage > system preference > default light
function initTheme(): string {
  const stored = localStorage.getItem('filecloud-theme');
  if (stored === 'dark' || stored === 'light') return stored;
  if (window.matchMedia('(prefers-color-scheme: dark)').matches) return 'dark';
  return 'light';
}

function applyTheme(theme: string) {
  const el = document.documentElement;
  el.setAttribute('data-theme', theme);
  // TDesign dark mode compat
  if (theme === 'dark') {
    el.setAttribute('theme-mode', 'dark');
  } else {
    el.removeAttribute('theme-mode');
  }
}

const currentTheme = initTheme();
applyTheme(currentTheme);

// Listen for system theme changes (only when user hasn't explicitly chosen)
if (!localStorage.getItem('filecloud-theme')) {
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', (e) => {
    const next = e.matches ? 'dark' : 'light';
    applyTheme(next);
    // Refresh echarts theme on switch
    import('./utils/echarts-theme').then(({ refreshChartTheme }) => refreshChartTheme());
  });
}

// Expose theme setter for use in settings page / theme toggle components
(window as any).__setFileCloudTheme = (theme: 'light' | 'dark') => {
  localStorage.setItem('filecloud-theme', theme);
  applyTheme(theme);
  import('./utils/echarts-theme').then(({ refreshChartTheme }) => refreshChartTheme());
};

async function bootstrapFrontend() {
  const app = createApp(App);
  const pinia = createPinia();

  app.use(pinia);
  app.use(router);

  // 非阻塞初始化公共配置（网站标题）：侧栏与浏览器标签共用 store 的响应式
  // 标题；失败 / 超时保留默认值，不阻塞挂载。保存成功后的同步走 store 本地提交。
  void usePublicConfigStore().fetchSiteTitle();

  app.component('TIcon', TIcon);

  app.mount('#app');

  // 路由级预载：根据当前路由在空闲时预加载相邻路由 chunk
  setupRoutePrefetch(router);
}

bootstrapFrontend().catch(console.error);
