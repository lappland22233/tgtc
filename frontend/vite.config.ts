import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';
import Components from 'unplugin-vue-components/vite';
import { TDesignResolver } from 'unplugin-vue-components/resolvers';
import { resolve } from 'path';

export default defineConfig({
  plugins: [
    vue(),
    Components({
      resolvers: [
        TDesignResolver({
          library: 'vue-next',
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
        target: 'http://localhost:3000',
        changeOrigin: true,
      },
    },
  },
  build: {
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
});
