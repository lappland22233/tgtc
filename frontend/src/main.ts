import { createApp } from 'vue';
import { createPinia } from 'pinia';
import TDesign from 'tdesign-vue-next';
import App from './App.vue';
import router from './router';
import 'tdesign-vue-next/dist/tdesign.css';
import './assets/styles.css';

const app = createApp(App);
const pinia = createPinia();

app.use(pinia);
app.use(router);
app.use(TDesign);
app.mount('#app');
