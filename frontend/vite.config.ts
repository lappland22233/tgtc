import { defineConfig, loadEnv } from 'vite';
import vue from '@vitejs/plugin-vue';
import Components from 'unplugin-vue-components/vite';
import { TDesignResolver } from 'unplugin-vue-components/resolvers';
import { resolve } from 'path';

const DEV_CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "script-src 'self' https://challenges.cloudflare.com https://static.cloudflareinsights.com",
  "style-src 'self' 'unsafe-inline'",
  "font-src 'self' data:",
  "img-src 'self' data: blob:",
  "connect-src 'self' ws://localhost:* ws://127.0.0.1:* wss://localhost:* https://challenges.cloudflare.com https://cloudflareinsights.com https://*.cloudflareinsights.com",
  "frame-src 'self' https://challenges.cloudflare.com",
  "media-src 'self' blob:",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
].join('; ');

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');

  return {
    plugins: [
      vue(),
      Components({
        resolvers: [
          TDesignResolver({
            library: 'vue-next',
            importStyle: false,
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
      headers: {
        'Content-Security-Policy': DEV_CONTENT_SECURITY_POLICY,
      },
      proxy: {
        '/api': {
          target: env.VITE_API_PROXY_TARGET || 'http://localhost:3000',
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
            if (id.includes('/node_modules/echarts') || id.includes('/node_modules/zrender')) return 'echarts';
            if (id.includes('/node_modules/tdesign')) return 'tdesign';
            if (id.includes('/node_modules/grid-layout-plus') || id.includes('/node_modules/vue-grid-layout')) return 'grid-layout';
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
