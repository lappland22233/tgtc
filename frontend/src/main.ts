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
app.mount('#app');
