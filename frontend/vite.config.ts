import { defineConfig, loadEnv } from 'vite';
import vue from '@vitejs/plugin-vue';
import Components from 'unplugin-vue-components/vite';
import { TDesignResolver } from 'unplugin-vue-components/resolvers';
import { resolve } from 'path';

export default defineConfig(({ mode }) => {
  // 读取 .env / .env.[mode]，允许 VITE_ 前缀外的变量（如代理目标）
  const env = loadEnv(mode, process.cwd(), '');

  return {
    plugins: [
      vue(),
      Components({
        resolvers: [
          TDesignResolver({
            library: 'vue-next',
            // 样式已在 main.ts 全量引入（tdesign-vue-next/dist/tdesign.css），
            // 显式关闭按需样式注入，避免重复加载与 less/css 解析差异
            importStyle: false,
            // <t-icon> 不走 TDesign 自动解析（其导出的 Icon 不接受 name 属性），
            // 改由 main.ts 全局注册的 TIcon 包装组件按名称映射真实图标
            exclude: [/^TIcon$/],
          }),
        ],
      }),
    ],
    resolve: {
      alias: {
        '@': resolve(__dirname, 'src'),
      },
    },
    server: {
      port: 5173,
      proxy: {
        '/api': {
          // 代理目标可通过环境变量覆盖（默认 localhost:3000），避免硬编码
          target: env.VITE_API_PROXY_TARGET || 'http://localhost:3000',
          changeOrigin: true,
        },
      },
    },
    build: {
      // 保持 es2020 以兼容较旧浏览器；
      // 注意：crypto.randomUUID() 等 ES2022 运行时 API 不会被 target 转译，
      // 使用处（UploadModal genUid）已做运行时降级，无需提升 target。
      target: 'es2020',
      chunkSizeWarningLimit: 1500,
      rollupOptions: {
        output: {
          manualChunks(id) {
            if (!id.includes('/node_modules/')) return;
            // ECharts + zrender (rendering engine) — tree-shaken to ~350 kB
            if (id.includes('/node_modules/echarts') || id.includes('/node_modules/zrender')) {
              return 'echarts';
            }
            // TDesign UI + icons
            if (id.includes('/node_modules/tdesign')) {
              return 'tdesign';
            }
            // 仪表盘网格布局（grid-layout-plus，Vue3 版）单独分包，避免进主包
            if (id.includes('/node_modules/grid-layout-plus') || id.includes('/node_modules/vue-grid-layout')) {
              return 'grid-layout';
            }
            // Vue core ecosystem
            if (
              id.includes('/node_modules/vue/') ||
              id.includes('/node_modules/@vue/') ||
              id.includes('/node_modules/vue-router') ||
              id.includes('/node_modules/pinia')
            ) {
              return 'vue-vendor';
            }
          },
        },
      },
    },
  };
});
