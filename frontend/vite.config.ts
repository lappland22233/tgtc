import { loadEnv } from 'vite';
import { defineConfig } from 'vitest/config';
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
    test: {
      fileParallelism: false,
      maxWorkers: 1,
      coverage: {
        provider: 'v8',
        include: ['src/**/*.{js,jsx,ts,tsx,mjs,mts,cjs,cts,vue}', 'scripts/**/*.mjs', 'public/**/*.js'],
        exclude: ['**/*.{spec,test}.*', '**/*.d.ts'],
        reporter: ['text', 'lcov', 'json-summary'],
        // Vitest 5 AST coverage of the 418 tests at 1e17ac1, across all 127 source files.
        // Reference counts: 5,118/13,084 statements, 3,438/9,398 branches,
        // 1,127/3,376 functions and 4,770/11,440 lines.
        thresholds: { statements: 40, branches: 36.58, functions: 33.38, lines: 41.69 },
      },
    },
    plugins: [
      vue(),
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
