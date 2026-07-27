/**
 * 前端遥测收集器
 * 自动采集 JS 错误、页面性能、设备环境信息，批量上报到后端。
 * 用于后续错误排查和性能优化。
 */

import api from '../api/client';

export type TelemetryEventType =
  | 'error'
  | 'api_error'
  | 'upload_error'
  | 'performance'
  | 'environment'
  | 'click_context';

interface TelemetryEvent {
  type: TelemetryEventType;
  data: Record<string, any>;
  clientTimestamp: number;
}

// ---- 缓冲与上报配置 ----
const MAX_BUFFER_SIZE = 20;
const MAX_BUFFER_CAPACITY = 200;
const FLUSH_INTERVAL_MS = 30_000;
const RETRY_BASE_DELAY_MS = 2_000;
const MAX_FLUSH_RETRIES = 3;

let buffer: TelemetryEvent[] = [];
let flushTimer: ReturnType<typeof setTimeout> | null = null;
let flushInFlight: Promise<void> | null = null;
let initialized = false;

// ---- URL 脱敏（防止 token/分享密钥随遥测上传） ----

/** query 中出现即视为敏感的参数名（小写比较） */
const SENSITIVE_QUERY_PARAMS = new Set([
  'token', 'access', 'accesstoken', 'access_token', 'accessjwt',
  'key', 'apikey', 'api_key', 'sharekey',
  'authorization', 'auth', 'secret', 'password', 'pwd',
  'jwt', 'signature', 'sign', 'code',
]);

/**
 * 上报前剥离 URL 中的敏感信息：
 * - query 中的敏感参数值替换为 [redacted]
 * - hash 整体移除（SPA 常把分享密钥/JWT 放在 hash 中）
 * 相对路径（如路由 fullPath）仅保留 pathname + search。
 */
function sanitizeUrl(input: string): string {
  if (!input) return '';
  try {
    const isAbsolute = /^(?:https?:)?\/\//i.test(input);
    const u = new URL(input, window.location.origin);
    for (const name of Array.from(u.searchParams.keys())) {
      if (SENSITIVE_QUERY_PARAMS.has(name.toLowerCase())) {
        u.searchParams.set(name, '[redacted]');
      }
    }
    u.hash = '';
    const safe = u.pathname + u.search;
    return isAbsolute ? u.origin + safe : safe;
  } catch {
    // 解析失败时保守处理：丢弃 query 与 hash
    return input.split(/[?#]/)[0];
  }
}

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

/**
 * 敏感元素黑名单：命中则完全跳过采集，避免记录密码、输入内容等 PII。
 * - 密码输入框及其内部点击
 * - 任何表单输入控件（其周边文本可能含用户数据）
 * - 业务侧可通过 data-telemetry-sensitive 属性显式标记敏感容器
 */
const SENSITIVE_SELECTOR = [
  'input[type="password"]',
  'input[type="text"]',
  'input[type="email"]',
  'input[type="tel"]',
  'input[type="number"]',
  'input[type="search"]',
  'textarea',
  'select',
  '[data-telemetry-sensitive]',
].join(',');

/** 文本脱敏：去除邮箱/手机号/URL/连续数字等 PII 模式，压缩空白并截断 */
function sanitizeText(raw: string): string {
  return raw
    .replace(/https?:\/\/\S+/gi, '[url]')              // URL（可能含 token/分享密钥）
    .replace(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g, '[email]') // 邮箱
    .replace(/(?<!\d)1[3-9]\d{9}(?!\d)/g, '[phone]')   // 国内手机号
    .replace(/\d{4,}/g, '[num]')                       // 4 位以上连续数字（验证码/ID/卡号等）
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 50);
}

/** 记录单次点击（静默，已做 PII 脱敏） */
function recordClick(e: MouseEvent) {
  const el = e.target as HTMLElement;
  if (!el) return;
  // 黑名单过滤：敏感元素（密码框/输入控件/敏感容器）直接不采集
  if (typeof el.closest === 'function' && el.closest(SENSITIVE_SELECTOR)) return;
  clickBuffer.push({
    time: Date.now(),
    tag: el.tagName.toLowerCase(),
    id: sanitizeText(el.id || ''),
    class: (el.className && typeof el.className === 'string') ? sanitizeText(el.className).slice(0, 100) : '',
    text: sanitizeText(el.textContent || ''),
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
  const icon = event.type === 'error' || event.type === 'api_error' || event.type === 'upload_error'
    ? '❌'
    : event.type === 'performance'
      ? '⚡'
      : '🌐';
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
    case 'api_error': {
      const d = event.data;
      const statusColor = d.status >= 500 ? 'color: #ef5350;' : d.status >= 400 ? 'color: #ff9800;' : 'color: #999;';
      console.groupCollapsed(`%c${title}`, `font-weight: bold; ${statusColor}`);
      console.log(`${d.method || 'GET'} ${d.url}`);
      console.log(`状态码: ${d.status || 0} · 耗时: ${d.duration || 0}ms`);
      if (d.message) console.log('错误信息:', d.message);
      if (d.errorCode) console.log('错误码:', d.errorCode);
      console.groupEnd();
      break;
    }
    case 'upload_error': {
      const d = event.data;
      console.groupCollapsed(`%c${title}`, 'font-weight: bold; color: #ef5350;');
      console.log(`阶段: ${d.stage || '-'} · 文件: ${d.fileName || '-'}`);
      console.log('错误:', d.message || '-');
      if (d.uploadId) console.log('上传会话:', d.uploadId);
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

/** 添加事件到有界缓冲，触发条件刷新 */
function enqueue(event: TelemetryEvent) {
  buffer.push(event);
  if (buffer.length > MAX_BUFFER_CAPACITY) {
    buffer.splice(0, buffer.length - MAX_BUFFER_CAPACITY);
  }
  printToConsole(event);
  if (buffer.length >= MAX_BUFFER_SIZE) {
    void flush();
  }
}

function scheduleFlush(delay = FLUSH_INTERVAL_MS) {
  if (!initialized) return;
  if (flushTimer) clearTimeout(flushTimer);
  flushTimer = setTimeout(() => void flush(), delay);
}

/** 上报缓冲中的遥测数据；失败事件回队并指数退避，避免网络抖动直接丢日志 */
async function flush(retryCount = 0): Promise<void> {
  if (flushInFlight) return flushInFlight;
  if (buffer.length === 0) {
    scheduleFlush();
    return;
  }

  const events = buffer.splice(0, MAX_BUFFER_SIZE);
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }

  flushInFlight = (async () => {
    try {
      await api.post('/telemetry/report', { events }, {
        timeout: 5000,
        headers: { 'X-Telemetry-Internal': '1' },
      });
      scheduleFlush(buffer.length > 0 ? 0 : FLUSH_INTERVAL_MS);
    } catch {
      buffer = [...events, ...buffer].slice(0, MAX_BUFFER_CAPACITY);
      const nextRetry = Math.min(retryCount + 1, MAX_FLUSH_RETRIES);
      const delay = nextRetry >= MAX_FLUSH_RETRIES
        ? FLUSH_INTERVAL_MS
        : RETRY_BASE_DELAY_MS * Math.pow(2, nextRetry - 1);
      scheduleFlush(delay);
    } finally {
      flushInFlight = null;
    }
  })();

  return flushInFlight;
}

// ---- API 错误追踪（模块加载时立即注册，确保在首次 API 请求前生效） ----
type TimedRequestConfig = { telemetryStartedAt?: number; headers?: { get?: (name: string) => unknown } };

api.interceptors.request.use((config) => {
  (config as TimedRequestConfig).telemetryStartedAt = performance.now();
  return config;
});

api.interceptors.response.use(
  (response) => response,
  (error) => {
    const config = error.config as (typeof error.config & TimedRequestConfig) | undefined;
    const isInternalReport = config?.headers?.get?.('X-Telemetry-Internal') === '1';
    if (!isInternalReport) {
      const status = Number(error.response?.status || 0);
      const responseData = error.response?.data as { message?: string | string[]; code?: string | number } | undefined;
      const rawMessage = Array.isArray(responseData?.message)
        ? responseData.message.join('; ')
        : responseData?.message || error.message || '请求失败';
      const duration = config?.telemetryStartedAt != null
        ? Math.max(0, Math.round(performance.now() - config.telemetryStartedAt))
        : 0;

      enqueue({
        type: 'api_error',
        clientTimestamp: Date.now(),
        data: {
          message: sanitizeText(String(rawMessage)).slice(0, 200),
          tag: status >= 500 ? 'server_response' : status > 0 ? 'backend_response' : 'network_failure',
          url: sanitizeUrl(config?.url || ''),
          method: config?.method?.toUpperCase() || '',
          status,
          duration,
          errorCode: responseData?.code != null ? String(responseData.code).slice(0, 64) : '',
        },
      });
      onErrorOccurred();
    }
    return Promise.reject(error);
  },
);

  // 拦截 fetch 请求（全局 fetch 覆写）
  // 防重复补丁：模块可能被动态 import 多次或与第三方 SDK 叠加，
  // 重复覆写会形成调用链放大延迟并互相干扰，这里保证只补丁一次并保留原始引用。
  let origFetch: typeof window.fetch | null = null;
  function patchGlobalFetch() {
    if (origFetch || typeof window === 'undefined' || typeof window.fetch !== 'function') return;
    origFetch = window.fetch.bind(window);
    window.fetch = async function (input: RequestInfo | URL, init?: RequestInit) {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      const start = performance.now();
      try {
        const res = await origFetch!(input, init);
        const elapsed = Math.round(performance.now() - start);
        if (res.status >= 400) {
          enqueue({
            type: 'api_error',
            clientTimestamp: Date.now(),
            data: {
              message: `Fetch 请求失败 (${res.status})`,
              tag: res.status >= 500 ? 'server_response' : 'backend_response',
              url: sanitizeUrl(url),
              method: init?.method?.toUpperCase() || 'GET',
              status: res.status,
              duration: elapsed,
            },
          });
          onErrorOccurred();
        }
        return res;
      } catch (err: any) {
        const elapsed = Math.round(performance.now() - start);
        enqueue({
          type: 'api_error',
          clientTimestamp: Date.now(),
          data: {
            message: sanitizeText(err.message || 'fetch failed'),
            tag: 'network_failure',
            url: sanitizeUrl(url),
            method: init?.method?.toUpperCase() || 'GET',
            status: 0,
            duration: elapsed,
          },
        });
        onErrorOccurred();
        throw err;
      }
    };
  }
  patchGlobalFetch();

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
  if (typeof window === 'undefined' || !window.performance) return;

  // 页面完全加载后延迟收集，确保所有指标就绪
  const collect = () => {
    // 优先使用 Navigation Timing Level 2（performance.timing 已废弃）
    const navEntry = performance.getEntriesByType('navigation')[0] as
      | PerformanceNavigationTiming
      | undefined;

    if (navEntry) {
      const navType = navEntry.type === 'reload' ? 1 : navEntry.type === 'back_forward' ? 2 : 0;
      enqueue({
        type: 'performance',
        clientTimestamp: Math.round(navEntry.startTime || Date.now()),
        data: {
          url: sanitizeUrl(location.href),
          dns: Math.round(navEntry.domainLookupEnd - navEntry.domainLookupStart),
          tcp: Math.round(navEntry.connectEnd - navEntry.connectStart),
          ttfb: Math.round(navEntry.responseStart - navEntry.requestStart),
          domReady: Math.round(navEntry.domContentLoadedEventEnd),
          pageLoad: Math.round(navEntry.loadEventEnd),
          redirect: Math.round(navEntry.redirectEnd - navEntry.redirectStart),
          domComplete: Math.round(navEntry.domComplete),
          navType,
          fcp: getPaintTime('first-contentful-paint'),
        },
      });
      return;
    }

    // 回退：已废弃的 Level 1 API（旧浏览器）
    const timing = window.performance.timing;
    const nav = window.performance.navigation;
    if (!timing) return;

    enqueue({
      type: 'performance',
      clientTimestamp: timing.navigationStart,
      data: {
        url: sanitizeUrl(location.href),
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

        // 首次内容绘制 (FCP)
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
      // navigator.platform 已废弃，优先使用 User-Agent Client Hints
      platform: (navigator as any).userAgentData?.platform || navigator.platform || '',
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
          message: `资源加载失败: ${tag} ${sanitizeUrl(src)}`,
          source: sanitizeUrl(src),
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
      source: sanitizeUrl(location.href),
      lineno: 0,
      colno: 0,
      stack: error.stack || '',
      tag: 'vue',
      vueInfo: info,
    },
  });
}

// ---- 页面离开时刷新 ----
/** 遥测上报端点（与 flush 中 api.post('/telemetry/report') + baseURL '/api' 保持一致） */
const REPORT_ENDPOINT = '/api/telemetry/report';

function onUnload() {
  if (buffer.length === 0) return;

  const events = buffer.splice(0);
  const payload = JSON.stringify({ events });

  // 使用 sendBeacon 保证页面卸载时可靠发送
  if (navigator.sendBeacon) {
    try {
      const blob = new Blob([payload], { type: 'application/json' });
      navigator.sendBeacon(REPORT_ENDPOINT, blob);
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
  scheduleFlush();

  // 页面离开时发送残留数据
  window.addEventListener('beforeunload', onUnload);
  window.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') {
      onUnload();
    } else if (document.visibilityState === 'visible' && initialized && !flushTimer) {
      scheduleFlush();
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
        url: sanitizeUrl(to.fullPath || ''),
        pageLoad: duration,
        navType: 4, // SPA 路由切换
        tag: 'spa_navigation',
      },
    });

    navStart = 0;
  });
}

/** 手动上报自定义事件（供业务代码调用） */
export function reportTelemetry(type: TelemetryEventType, data: Record<string, any>) {
  enqueue({ type, data, clientTimestamp: Date.now() });
}

/** 结构化上报上传失败，不采集文件内容，仅保留诊断所需元数据 */
export function reportUploadError(input: {
  stage: string;
  message: string;
  fileName?: string;
  fileSize?: number;
  mimeType?: string;
  uploadId?: string | null;
  status?: number;
  retryCount?: number;
}) {
  onErrorOccurred();
  enqueue({
    type: 'upload_error',
    clientTimestamp: Date.now(),
    data: {
      ...input,
      message: sanitizeText(input.message).slice(0, 200),
      fileName: sanitizeText(input.fileName || '').slice(0, 120),
      mimeType: (input.mimeType || '').slice(0, 100),
      tag: input.stage,
      url: sanitizeUrl(location.href),
    },
  });
}
