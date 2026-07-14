/**
 * 前端遥测收集器
 * 自动采集 JS 错误、页面性能、设备环境信息，批量上报到后端。
 * 用于后续错误排查和性能优化。
 */

import api from '../api/client';

interface TelemetryEvent {
  type: 'error' | 'performance' | 'environment' | 'click_context' | 'network';
  data: Record<string, any>;
  clientTimestamp: number;
}

// ---- 缓冲与上报配置 ----
const MAX_BUFFER_SIZE = 20;
const FLUSH_INTERVAL_MS = 30_000; // 30 秒自动刷新

let buffer: TelemetryEvent[] = [];
let flushTimer: ReturnType<typeof setTimeout> | null = null;
let initialized = false;

// ---- 点击上下文追踪（仅在错误时上报） ----
const CLICK_CONTEXT_PRE = 2 * 60 * 1000;  // 错误前 2 分钟
const CLICK_CONTEXT_POST = 1 * 60 * 1000; // 错误后 1 分钟
const CLICK_BUFFER_MAX = 300;            // 最大缓存点击数（约 3 分钟正常点击）

interface ClickRecord {
  time: number;
  tag: string;
  id: string;
  class: string;
  text: string;
}
let clickBuffer: ClickRecord[] = [];
let errorOccurred = false;
let postErrorCollector: ReturnType<typeof setTimeout> | null = null;

/** 记录单次点击（静默） */
function recordClick(e: MouseEvent) {
  const el = e.target as HTMLElement;
  if (!el) return;
  // 截取前 50 个字符避免存储敏感数据
  const text = (el.textContent || '').trim().slice(0, 50);
  clickBuffer.push({
    time: Date.now(),
    tag: el.tagName.toLowerCase(),
    id: el.id || '',
    class: (el.className && typeof el.className === 'string') ? el.className.slice(0, 100) : '',
    text,
  });
  if (clickBuffer.length > CLICK_BUFFER_MAX) {
    clickBuffer = clickBuffer.slice(-CLICK_BUFFER_MAX);
  }
}

/** 错误发生时：刷新错误前 2 分钟 + 错误后 1 分钟的点击上下文 */
function flushClickContext(triggeredByError: boolean) {
  if (clickBuffer.length === 0) return;

  const now = Date.now();
  const windowMs = triggeredByError ? CLICK_CONTEXT_PRE : CLICK_CONTEXT_POST;
  const beforeCutoff = now - windowMs;
  const contextClicks = clickBuffer.filter(c => c.time >= beforeCutoff);

  if (contextClicks.length > 0) {
    enqueue({
      type: 'click_context',
      clientTimestamp: now,
      data: {
        totalClicks: contextClicks.length,
        window: triggeredByError ? 'pre_2min' : 'post_1min',
        clicks: contextClicks,
      },
    });
  }

  // 错误后清空缓冲区重新开始采集
  clickBuffer = [];
}

/** 启动错误后 1 分钟持续采集 */
function startPostErrorCollection() {
  if (postErrorCollector) clearTimeout(postErrorCollector);
  postErrorCollector = setTimeout(() => {
    flushClickContext(false);
    errorOccurred = false;
    postErrorCollector = null;
  }, CLICK_CONTEXT_POST);
}

/** 启动点击事件监听 */
function startClickTracking() {
  document.addEventListener('click', recordClick, { passive: true, capture: true });
}

/** 错误发生时触发：上报错误前 5 分钟点击上下文 + 启动错误后 5 分钟追踪 */
function onErrorOccurred() {
  if (errorOccurred) return; // 同一轮错误只触发一次
  errorOccurred = true;
  flushClickContext(true);
  startPostErrorCollection();
}

// ---- 控制台可视化 ----
function printToConsole(event: TelemetryEvent) {
  // 仅开发模式打印
  // 移除限制：生产环境也展示，做到遥测透明化
  // if (import.meta.env.PROD) return;

  const time = new Date(event.clientTimestamp).toLocaleTimeString();
  const icon = event.type === 'error' ? '❌' : event.type === 'performance' ? '⚡' : event.type === 'network' ? '🌐' : '🌐';
  const title = `${icon} [Telemetry] ${event.type.toUpperCase()} · ${time}`;

  switch (event.type) {
    case 'environment': {
      const d = event.data;
      console.groupCollapsed(`%c${title}`, 'color: #4fc3f7; font-weight: bold;');
      console.log('屏幕:', `${d.screen} (DPR ${d.devicePixelRatio || 1})`);
      console.log('视口:', d.viewport);
      console.log('系统:', `${d.platform} | ${d.language} | ${d.timezone}`);
      console.log('在线:', d.onLine ?? true, '| 来源:', d.referrer || '(无)');
      console.groupEnd();
      break;
    }
    case 'performance': {
      const d = event.data;
      console.groupCollapsed(`%c${title}`, 'color: #81c784; font-weight: bold;');
      console.table({
        'DNS 解析': d.dns + 'ms',
        'TCP 连接': d.tcp + 'ms',
        '首字节 (TTFB)': d.ttfb + 'ms',
        'DOM 就绪': d.domReady + 'ms',
        '页面加载': d.pageLoad + 'ms',
        '首次绘制 (FCP)': d.fcp != null ? d.fcp + 'ms' : '不支持',
      });
      console.log('页面:', d.url);
      console.log('导航类型:', d.navType === 0 ? '正常导航' : d.navType === 1 ? '刷新' : '前进/后退');
      console.groupEnd();
      break;
    }
    case 'error': {
      const d = event.data;
      const isAsset = d.tag === 'asset_error';
      const color = isAsset ? 'color: #ffb74d;' : 'color: #ef5350;';
      console.groupCollapsed(`%c${title}`, `font-weight: bold; ${color}`);
      console.log('消息:', d.message);
      if (d.source && !isAsset) console.log('来源:', `${d.source}:${d.lineno}:${d.colno}`);
      if (d.tag) console.log('标签:', d.tag);
      if (d.vueInfo) console.log('Vue 信息:', d.vueInfo);
      if (d.stack) {
        console.groupCollapsed('堆栈');
        console.log(d.stack);
        console.groupEnd();
      }
      console.groupEnd();
      break;
    }
    case 'network': {
      const d = event.data;
      const statusColor = d.status >= 500 ? 'color: #ef5350;' : d.status >= 400 ? 'color: #ff9800;' : d.status >= 300 ? 'color: #ffeb3b;' : 'color: #999;';
      console.groupCollapsed(`%c${title}`, `font-weight: bold; ${statusColor}`);
      console.log(`${d.method || 'GET'} ${d.url}`);
      console.log(`状态码: ${d.status} · 耗时: ${d.duration}ms`);
      if (d.redirect) console.log('重定向:', d.redirect);
      if (d.body) console.log('错误信息:', d.body);
      if (d.error) console.log('网络错误:', d.error);
      console.groupEnd();
      break;
    }
    case 'click_context': {
      const d = event.data;
      console.groupCollapsed(`%c${title}`, 'font-weight: bold; color: #ce93d8;');
      console.log(`窗口: ${d.window} · 点击数: ${d.totalClicks}`);
      if (d.clicks && d.clicks.length > 0) {
        console.table(d.clicks.slice(0, 20), ['time', 'tag', 'id', 'class', 'text']);
        if (d.clicks.length > 20) {
          console.log(`... 还有 ${d.clicks.length - 20} 条点击记录`);
        }
      }
      console.groupEnd();
      break;
    }
  }
}

/** 添加事件到缓冲，触发条件刷新 */
function enqueue(event: TelemetryEvent) {
  buffer.push(event);
  // 开发环境下实时打印到控制台
  printToConsole(event);
  if (buffer.length >= MAX_BUFFER_SIZE) {
    flush();
  }
}

/** 上报缓冲中的遥测数据 */
async function flush() {
  if (buffer.length === 0) return;

  const events = buffer.splice(0);
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }

  try {
    await api.post('/telemetry/report', { events }, { timeout: 5000 });
  } catch {
    // 静默失败 — 不影响用户使用
  }

  // 重新启动定时器
  if (initialized) {
    flushTimer = setTimeout(flush, FLUSH_INTERVAL_MS);
  }
}

// ---- 网络状态追踪（模块加载时立即注册，确保在首次 API 请求前生效） ----
api.interceptors.response.use(
    (response) => {
      // 3xx 重定向上报
      if (response.status >= 300 && response.status < 400) {
        enqueue({
          type: 'network',
          clientTimestamp: Date.now(),
          data: {
            url: response.config?.url || '',
            method: response.config?.method?.toUpperCase() || '',
            status: response.status,
            duration: Math.round(performance.now()),
            redirect: response.headers?.location || '',
          },
        });
      }
      return response;
    },
    (error) => {
      const status = error.response?.status;
      // 仅上报 4xx（客户端错误）和 5xx（服务端错误）
      if (status && status >= 400) {
        enqueue({
          type: 'network',
          clientTimestamp: Date.now(),
          data: {
            url: error.config?.url || '',
            method: error.config?.method?.toUpperCase() || '',
            status,
            duration: Math.round(performance.now()),
            body: status < 500
              ? (error.response?.data?.message || error.message || '').slice(0, 200)
              : '',
          },
        });
      }
      return Promise.reject(error);
    },
  );

  // 拦截 fetch 请求（全局 fetch 覆写）
  const origFetch = window.fetch;
  window.fetch = async function (input: RequestInfo | URL, init?: RequestInit) {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    const start = performance.now();
    try {
      const res = await origFetch.call(window, input, init);
      const elapsed = Math.round(performance.now() - start);
      // 3xx/4xx/5xx 上报
      if (res.status >= 300) {
        enqueue({
          type: 'network',
          clientTimestamp: Date.now(),
          data: {
            url,
            method: init?.method?.toUpperCase() || 'GET',
            status: res.status,
            duration: elapsed,
          },
        });
      }
      return res;
    } catch (err: any) {
      const elapsed = Math.round(performance.now() - start);
      enqueue({
        type: 'network',
        clientTimestamp: Date.now(),
        data: {
          url,
          method: init?.method?.toUpperCase() || 'GET',
          status: 0,
          duration: elapsed,
          error: err.message || 'fetch failed',
        },
      });
      throw err;
    }
  };

// ---- 错误采集 ----
function captureErrors() {
  // 全局 JavaScript 错误
  window.addEventListener('error', (event) => {
    if (event.target instanceof Element) return; // 忽略资源加载错误（如图片 404）
    onErrorOccurred();
    enqueue({
      type: 'error',
      clientTimestamp: Date.now(),
      data: {
        message: event.message,
        source: event.filename,
        lineno: event.lineno,
        colno: event.colno,
        stack: event.error?.stack || '',
        tag: 'uncaught',
      },
    });
  });

  // 未处理的 Promise 拒绝
  window.addEventListener('unhandledrejection', (event) => {
    const reason = event.reason;
    onErrorOccurred();
    enqueue({
      type: 'error',
      clientTimestamp: Date.now(),
      data: {
        message: reason instanceof Error ? reason.message : String(reason),
        stack: reason instanceof Error ? reason.stack || '' : '',
        tag: 'unhandled_rejection',
      },
    });
  });

  // Vue 组件错误（在 main.ts 中通过 app.config.errorHandler 单独处理）
}

// ---- 性能采集 ----
function capturePerformance() {
  if (typeof window === 'undefined' || !window.performance?.timing) return;

  // 页面完全加载后延迟收集，确保所有指标就绪
  const collect = () => {
    const timing = window.performance.timing;
    const nav = window.performance.navigation;

    enqueue({
      type: 'performance',
      clientTimestamp: timing.navigationStart,
      data: {
        url: location.href,
        // 关键性能指标（毫秒）
        dns: timing.domainLookupEnd - timing.domainLookupStart,
        tcp: timing.connectEnd - timing.connectStart,
        ttfb: timing.responseStart - timing.requestStart,
        domReady: timing.domContentLoadedEventEnd - timing.navigationStart,
        pageLoad: timing.loadEventEnd - timing.navigationStart,
        redirect: timing.redirectEnd - timing.redirectStart,
        domComplete: timing.domComplete - timing.navigationStart,

        // 导航类型: 0=正常导航, 1=刷新, 2=前进/后退
        navType: nav?.type || 0,

        // 如果支持 Navigation Timing 2 API，额外采集
        fcp: getPaintTime('first-contentful-paint'),
      },
    });
  };

  if (document.readyState === 'complete') {
    setTimeout(collect, 2000); // 页面加载完成后延迟 2s 确保指标稳定
  } else {
    window.addEventListener('load', () => setTimeout(collect, 2000), { once: true });
  }
}

/** 获取 Paint Timing（FCP 等） */
function getPaintTime(entryName: string): number | null {
  try {
    const entries = performance.getEntriesByType('paint');
    const match = entries.find((e) => e.name === entryName);
    return match ? Math.round(match.startTime) : null;
  } catch {
    return null;
  }
}

// ---- 环境信息采集 ----
function captureEnvironment() {
  enqueue({
    type: 'environment',
    clientTimestamp: Date.now(),
    data: {
      screen: `${window.screen.width}x${window.screen.height}`,
      viewport: `${window.innerWidth}x${window.innerHeight}`,
      devicePixelRatio: window.devicePixelRatio || 1,
      platform: navigator.platform || '',
      language: navigator.language || '',
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || '',
      browser: navigator.appName || '',
      cookiesEnabled: navigator.cookieEnabled,
      onLine: navigator.onLine,
      referrer: document.referrer || '',
    },
  });
}

// ---- 应用级资源加载错误采集 ----
function captureAssetErrors() {
  window.addEventListener(
    'error',
    (event) => {
      if (!(event.target instanceof Element)) return;
      // 仅收集特定资源类型以避免噪音
      const el = event.target as HTMLElement & { src?: string; href?: string };
      const src = el.src || el.href || '';
      const tag = el.tagName?.toLowerCase() || '';
      if (!src || !['script', 'link'].includes(tag)) return;

      enqueue({
        type: 'error',
        clientTimestamp: Date.now(),
        data: {
          message: `资源加载失败: ${tag} ${src}`,
          source: src,
          lineno: 0,
          colno: 0,
          stack: '',
          tag: 'asset_error',
        },
      });
    },
    true, // 捕获阶段
  );
}

// ---- 白屏检测 ----
function checkWhiteScreen() {
  const doCheck = () => {
    const root = document.getElementById('app') || document.body;
    if (!root) return;

    const rect = root.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) {
      enqueue({
        type: 'error',
        clientTimestamp: Date.now(),
        data: {
          message: '白屏检测: 根元素无可见尺寸',
          tag: 'white_screen',
          stack: `width:${rect.width} height:${rect.height}`,
        },
      });
      return;
    }

    // 多维度判定白屏（任一维度不满足即放行）
    // 维度1: 可见文本长度 > 20 字符 → 放行
    const textLen = (root.textContent || '').replace(/\s/g, '').length;
    if (textLen >= 20) return;

    // 维度2: DOM 节点数 > 10 → 放行
    const allElements = root.querySelectorAll('*').length;
    if (allElements > 10) return;

    // 维度3: 有交互元素（button/a/input/img）→ 放行
    const interactives = root.querySelectorAll('button, a, input, img, [role], svg').length;
    if (interactives > 0) return;

    // 维度4: 有可见子元素（宽高 > 0）→ 放行
    const visibleChildren = Array.from(root.children).filter(c => {
      const r = c.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    }).length;
    if (visibleChildren > 0) return;

    // 维度5: 采样点检查（辅助确认）
    const samplePoints = [
      { x: rect.width * 0.5, y: rect.height * 0.4 },
      { x: rect.width * 0.5, y: rect.height * 0.6 },
    ];
    let emptyCount = 0;
    for (const pt of samplePoints) {
      const el = document.elementFromPoint(pt.x, pt.y);
      if (!el || el === root || el === document.body || el.tagName === 'HTML') {
        emptyCount++;
      }
    }
    if (emptyCount < 2) return;

    // 全部维度通过 → 确认白屏
    enqueue({
      type: 'error',
      clientTimestamp: Date.now(),
      data: {
        message: '白屏检测: 页面无可见内容',
        tag: 'white_screen',
        stack: `elements:${allElements} textLen:${textLen} interactives:${interactives} visibleChildren:${visibleChildren} emptyPoints:${emptyCount}`,
      },
    });
  };

  if (document.readyState === 'complete') {
    setTimeout(doCheck, 10000);
  } else {
    window.addEventListener('load', () => setTimeout(doCheck, 10000), { once: true });
  }
}

// ---- 组件渲染失败检测（全局 errorHandler 增强） ----
let vueRenderErrorCount = 0;
let lastRenderErrorTime = 0;

export function captureVueError(err: unknown, info: string) {
  const error = err instanceof Error ? err : new Error(String(err));
  const now = Date.now();

  // 组件渲染失败检测
  if (info.includes('render') || info.includes('setup') || info.includes('mount')) {
    vueRenderErrorCount++;
    lastRenderErrorTime = now;

    // 1 秒内超过 3 次渲染错误 = 组件渲染失败
    if (vueRenderErrorCount >= 3 && now - lastRenderErrorTime < 1000) {
      enqueue({
        type: 'error',
        clientTimestamp: now,
        data: {
          message: `组件渲染失败: ${error.message}`,
          tag: 'render_failure',
          stack: error.stack || '',
          vueInfo: info,
          consecutiveErrors: vueRenderErrorCount,
        },
      });
      vueRenderErrorCount = 0;
    }
  }

  // 每 5 秒重置计数器
  if (now - lastRenderErrorTime > 5000) {
    vueRenderErrorCount = 0;
  }

  onErrorOccurred();
  enqueue({
    type: 'error',
    clientTimestamp: Date.now(),
    data: {
      message: error.message,
      source: location.href,
      lineno: 0,
      colno: 0,
      stack: error.stack || '',
      tag: 'vue',
      vueInfo: info,
    },
  });
}

// ---- 页面离开时刷新 ----
function onUnload() {
  if (buffer.length === 0) return;

  const events = buffer.splice(0);
  const payload = JSON.stringify({ events });

  // 使用 sendBeacon 保证页面卸载时可靠发送
  if (navigator.sendBeacon) {
    try {
      const blob = new Blob([payload], { type: 'application/json' });
      navigator.sendBeacon('/api/telemetry/report', blob);
    } catch {
      // 静默失败
    }
  }
}

// ---- 初始化 ----
export function initTelemetry() {
  if (initialized) return;
  initialized = true;

  // 控制台启动标识（生产环境也显示）
  console.log(
    '%c🔍 遥测已启动 %c| 自动采集：错误 · 性能 · 环境信息',
    'color: #66bb6a; font-weight: bold;',
    'color: #aaa;',
  );

  captureErrors();
  captureAssetErrors();
  capturePerformance();
  captureEnvironment();
  startClickTracking();

  // 白屏检测（页面加载后 3 秒执行）
  checkWhiteScreen();

  // 页面重新可见时重新采样环境信息（用户可能切换显示器/窗口大小）
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      captureEnvironment();
    }
  });

  // 在线状态变化时上报
  window.addEventListener('online', () => {
    enqueue({
      type: 'environment',
      clientTimestamp: Date.now(),
      data: { event: 'online' },
    });
  });
  window.addEventListener('offline', () => {
    enqueue({
      type: 'environment',
      clientTimestamp: Date.now(),
      data: { event: 'offline' },
    });
  });

  // 每 30 秒自动刷新
  flushTimer = setTimeout(flush, FLUSH_INTERVAL_MS);

  // 页面离开时发送残留数据
  window.addEventListener('beforeunload', onUnload);
  window.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') {
      onUnload();
    } else if (document.visibilityState === 'visible' && initialized && !flushTimer) {
      flushTimer = setTimeout(flush, FLUSH_INTERVAL_MS);
      // 恢复标签页时重新采样环境
      captureEnvironment();
    }
  });
}

/**
 * 注册 Vue Router 路由切换追踪
 * 在 main.ts 中 mount 后调用 setupRouteTracking(router)
 */
export function setupRouteTracking(router: any) {
  if (!router) return;

  let navStart = 0;

  router.beforeEach(() => {
    navStart = performance.now();
  });

  router.afterEach((to: any) => {
    if (!navStart) return;
    const duration = Math.round(performance.now() - navStart);

    enqueue({
      type: 'performance',
      clientTimestamp: Date.now(),
      data: {
        url: to.fullPath,
        pageLoad: duration,
        navType: 4, // SPA 路由切换
        tag: 'spa_navigation',
      },
    });

    navStart = 0;
  });
}

/** 手动上报自定义事件（供业务代码调用） */
export function reportTelemetry(type: TelemetryEvent['type'], data: Record<string, any>) {
  enqueue({ type, data, clientTimestamp: Date.now() });
}
