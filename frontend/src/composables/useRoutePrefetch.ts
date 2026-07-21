import { watch } from 'vue';
import type { Router } from 'vue-router';

/**
 * 路由级预载 composable
 *
 * 根据当前路由，在空闲时预加载用户下一步可能访问的页面 chunk。
 * 使用 requestIdleCallback 避免阻塞用户交互，已预载的路由不重复加载。
 *
 * 路由邻接映射定义了从每个路由出发最可能访问的下一批路由。
 */

// 高频路由邻接映射（仅用户路由，admin 路由在 Layout.vue 按角色批量预载）
const ROUTE_PREFETCH_MAP: Record<string, string[]> = {
  '/dashboard': ['/files', '/settings'],
  '/files': ['/dashboard', '/settings'],
  '/settings': ['/dashboard', '/files'],
};

// 动态 import 映射 — 与 router/index.ts 的路由定义保持一致
const ROUTE_IMPORTERS: Record<string, () => Promise<unknown>> = {
  '/dashboard': () => import('../views/user/Dashboard.vue'),
  '/files': () => import('../views/user/FileList.vue'),
  '/settings': () => import('../views/user/Settings.vue'),
};

const prefetched = new Set<string>();
// 正在加载中的路由：避免对同一路由并发重复 import
const inFlight = new Set<string>();
const idleCb: (cb: () => void, opts?: { timeout: number }) => void =
  typeof requestIdleCallback !== 'undefined'
    ? requestIdleCallback
    : (cb) => setTimeout(cb, 500);

/**
 * 在应用启动时安装路由预载监听。
 * 监听路由变化，在空闲时预加载相邻路由的 chunk。
 */
export function setupRoutePrefetch(router: Router) {
  watch(
    () => router.currentRoute.value.path,
    (newPath) => {
      const adjacent = ROUTE_PREFETCH_MAP[newPath];
      if (!adjacent) return;

      // 省流模式下不预载，减少用户流量消耗
      const connection = (navigator as { connection?: { saveData?: boolean } }).connection;
      if (connection?.saveData) return;

      idleCb(
        () => {
          for (const route of adjacent) {
            if (prefetched.has(route) || inFlight.has(route)) continue;
            const importer = ROUTE_IMPORTERS[route];
            if (!importer) continue;
            inFlight.add(route);
            importer()
              .then(() => {
                // 仅在加载成功后标记为已预载；失败则不标记，允许下次重试
                prefetched.add(route);
              })
              .catch(() => {
                // chunk 加载失败：静默忽略，下次仍可重试
              })
              .finally(() => {
                inFlight.delete(route);
              });
          }
        },
        { timeout: 3000 },
      );
    },
    { immediate: true },
  );
}
