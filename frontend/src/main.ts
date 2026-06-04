import { createApp } from 'vue';
import { createPinia } from 'pinia';
import TDesign from 'tdesign-vue-next';
import App from './App.vue';
import router from './router';
import 'tdesign-vue-next/dist/tdesign.css';
import './assets/styles.css';

// 启用 TDesign 深色模式（设置 DOM 属性触发 CSS 变量）
document.documentElement.setAttribute('theme-mode', 'dark');

const app = createApp(App);
const pinia = createPinia();

app.use(pinia);
app.use(router);
app.use(TDesign);

// 全局错误边界：捕获未处理的组件错误，防止整个页面白屏
app.config.errorHandler = (err, _instance, info) => {
  console.error('[Vue Error]', err);
  console.error('Info:', info);
};

app.mount('#app');
