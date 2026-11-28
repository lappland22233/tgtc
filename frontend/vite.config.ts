import { loadEnv } from 'vite';
import { defineConfig } from 'vitest/config';
import vue from '@vitejs/plugin-vue';
import tailwindcss from '@tailwindcss/vite';
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
    test: {
      fileParallelism: false,
      maxWorkers: 1,
      coverage: {
        provider: 'v8',
        include: ['src/**/*.{js,jsx,ts,tsx,mjs,mts,cjs,cts,vue}', 'scripts/**/*.mjs', 'public/**/*.js'],
        exclude: ['**/*.{spec,test}.*', '**/*.d.ts'],
        reporter: ['text', 'lcov', 'json-summary'],
        // B-15：整数棘轮，取代钉死在历史 commit 1e17ac1 的小数水位。
        // 基线实测（2026-11-28，npx vitest run --coverage，52 文件 / 449 用例）：
        //   全局 statements 45.31 / branches 42.32 / functions 39.69 / lines 47.99
        //   src/api 68.99 / 63.23 / 63.82 / 68.25
        //   src/composables 60.13 / 46.56 / 61.41 / 64.43
        //   src/stores 57.30 / 46.02 / 60.53 / 61.30
        // 阈值取略低于实测的整数，补测后按同一口径上调；不要凭感觉钉数字。
        thresholds: { statements: 44, branches: 41, functions: 38, lines: 46 },
      },
    },
    plugins: [
      vue(),
      tailwindcss(),
      Components({
        dts: mode !== 'test',
        resolvers: [
          TDesignResolver({
            library: 'vue-next',
            exclude: [/^TIcon$/],
          }),
        ],
      }),
    ],
    resolve: {
      alias: {
        '@': resolve(import.meta.dirname, 'src'),
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
      rolldownOptions: {
        output: {
          codeSplitting: {
            groups: [
              { name: 'echarts', test: /\/node_modules\/(echarts|zrender)\// },
              { name: 'tdesign-icons', entriesAware: true, test: /\/node_modules\/tdesign-icons[^/]*\// },
              { name: 'vue-vendor', priority: 10, test: /\/node_modules\/(vue|@vue|vue-router|pinia)\// },
            ],
          },
        },
      },
    },
  };
});
