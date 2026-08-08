<template>
  <teleport to="body">
    <transition name="fpv-fade">
      <div
        v-if="visible"
        class="fpv-overlay"
        role="presentation"
        @click.self="close"
      >
        <div class="fpv-dialog" role="dialog" aria-modal="true" :aria-label="snap.name || '文件预览'">
          <!-- 头部：文件名 + 关闭 -->
          <div class="fpv-header">
            <div class="fpv-name" :title="snap.name">{{ snap.name || '文件预览' }}</div>
            <button type="button" class="fpv-close" aria-label="关闭预览" @click="close">
              <t-icon name="close" />
            </button>
          </div>

          <!-- 内容区：按 kind 分支懒挂载（关闭卸载即终止媒体流） -->
          <div class="fpv-body">
            <!-- 图片 -->
            <img
              v-if="snap.kind === 'image' && snap.src && !mediaError"
              class="fpv-image"
              :src="snap.src"
              :alt="snap.name"
              @error="onMediaError"
            />

            <!-- 视频：MSE 优先（持续消费完整响应流），不支持时原生回退 -->
            <div
              v-else-if="snap.kind === 'video' && snap.src && !mediaError"
              class="fpv-video-wrap"
            >
              <video
                ref="videoRef"
                class="fpv-video"
                :src="videoSrc || undefined"
                controls
                preload="auto"
                @seeking="onVideoSeeking"
                @seeked="onVideoSeeked"
                @waiting="videoBuffering = true"
                @playing="videoBuffering = false"
                @canplay="videoBuffering = false"
                @progress="updateBufferedRatio"
                @timeupdate="updateBufferedRatio"
                @error="onVideoError"
              />
              <div v-if="videoBuffering" class="fpv-video-loading">
                <t-loading
                  size="medium"
                  :text="videoBufferedRatio > 0 ? `正在缓冲…（已缓冲 ${videoBufferedRatio}%）` : '正在缓冲…'"
                />
              </div>
            </div>

            <!-- 音频 -->
            <audio
              v-else-if="snap.kind === 'audio' && snap.src && !mediaError"
              class="fpv-audio"
              :src="snap.src"
              controls
              @error="onMediaError"
            />

            <!-- PDF（浏览器原生内联渲染） -->
            <iframe
              v-else-if="snap.kind === 'pdf' && snap.src"
              class="fpv-pdf"
              :src="snap.src"
              :title="snap.name || 'PDF 预览'"
            />

            <!-- 文本：打开时 fetch 读取 -->
            <template v-else-if="snap.kind === 'text'">
              <div v-if="textLoading" class="fpv-state">
                <t-loading size="medium" text="正在加载文本内容..." />
              </div>
              <div v-else-if="textTooLarge" class="fpv-state fpv-error">
                <t-icon name="info-circle" class="fpv-state-icon" />
                <p>文件过大，请下载查看</p>
              </div>
              <div v-else-if="textError" class="fpv-state fpv-error">
                <t-icon name="close-circle" class="fpv-state-icon" />
                <p>{{ textError }}</p>
                <button type="button" class="fpv-btn" @click="handleDownload">
                  <t-icon name="download" />下载文件
                </button>
              </div>
              <pre v-else class="fpv-text">{{ textContent }}</pre>
            </template>

            <!-- 无法预览 / 媒体加载失败 -->
            <div v-else class="fpv-state fpv-error">
              <t-icon name="close-circle" class="fpv-state-icon" />
              <p>{{ mediaError ? '文件加载失败，可能无权访问该文件' : '无法预览该文件' }}</p>
              <button type="button" class="fpv-btn" @click="handleDownload">
                <t-icon name="download" />下载文件
              </button>
            </div>
          </div>

          <!-- 底部：元信息 + 常驻下载 -->
          <div class="fpv-footer">
            <span class="fpv-meta">
              <template v-if="snap.mimeType">{{ snap.mimeType }}</template>
              <template v-if="snap.size != null"> · {{ formatSize(snap.size) }}</template>
            </span>
            <button type="button" class="fpv-btn fpv-download" @click="handleDownload">
              <t-icon name="download" />下载
            </button>
          </div>
        </div>
      </div>
    </transition>
  </teleport>
</template>

<script setup lang="ts">
import { ref, reactive, watch, nextTick, onUnmounted } from 'vue';
import type { PreviewKind } from '../../utils/preview';
import { triggerBrowserDownload } from '../../utils/download';

const props = defineProps<{
  visible: boolean;
  /** 文件原始名（头部展示 + 下载文件名） */
  name?: string;
  mimeType?: string;
  size?: number;
  /** 预览类别；null 时显示「无法预览」兜底态 */
  kind: PreviewKind | null;
  /** 预览内容地址（同源 inline 接口） */
  src: string | null;
  /** 下载地址；未传时用 src 兜底 */
  downloadUrl?: string;
}>();

const emit = defineEmits<{
  'update:visible': [v: boolean];
}>();

/**
 * 打开时快照：父组件关闭时可能立即清空 src/name 等 props，
 * 而遮罩的淡出过渡仍在进行，快照保证退场期间内容不闪变。
 */
const snap = reactive({
  name: '',
  mimeType: '',
  size: null as number | null,
  kind: null as PreviewKind | null,
  src: null as string | null,
  downloadUrl: null as string | null,
});

const textLoading = ref(false);
const textContent = ref('');
const textError = ref<string | null>(null);
const textTooLarge = ref(false);
const mediaError = ref(false);

/** 文本预览大小上限：2MB（响应头超限或流式累积超限均停止读取） */
const TEXT_PREVIEW_LIMIT = 2 * 1024 * 1024;
/** 加载令牌：避免快速开关时旧请求结果覆盖新状态 */
let loadToken = 0;

function resetState() {
  loadToken++;
  teardownVideo();
  textLoading.value = false;
  textContent.value = '';
  textError.value = null;
  textTooLarge.value = false;
  mediaError.value = false;
}

watch(() => props.visible, (v) => {
  resetState();
  if (v) {
    snap.name = props.name || '';
    snap.mimeType = props.mimeType || '';
    snap.size = props.size ?? null;
    snap.kind = props.kind;
    snap.src = props.src;
    snap.downloadUrl = props.downloadUrl ?? null;
    if (props.kind === 'text') void loadText();
    // 视频：等 DOM 挂载出 <video> 后启动 MSE / 原生播放管线
    if (props.kind === 'video') nextTick(() => setupVideo());
  }
}, { immediate: true });

/** Esc 键关闭 */
function onKeydown(e: KeyboardEvent) {
  if (e.key === 'Escape' && props.visible) close();
}
watch(() => props.visible, (v) => {
  if (v) window.addEventListener('keydown', onKeydown);
  else window.removeEventListener('keydown', onKeydown);
});
onUnmounted(() => {
  window.removeEventListener('keydown', onKeydown);
  teardownVideo();
});

function close() {
  emit('update:visible', false);
}

/** 媒体元素加载失败（含 401/403 无权访问） */
function onMediaError() {
  mediaError.value = true;
}

// ============ 视频预览（MSE 优先 + 原生回退） ============
const videoRef = ref<HTMLVideoElement | null>(null);
/** 当前 <video> 实际 src：MSE 模式为 MediaSource 对象 URL，回退模式为原始地址 */
const videoSrc = ref<string | null>(null);
/** 是否处于 MSE 模式 */
const videoUseMse = ref(false);
/** 缓冲中提示 */
const videoBuffering = ref(false);
/** 已缓冲百分比（buffered 最大 end / duration 估算） */
const videoBufferedRatio = ref(0);
/** seek 钳制防循环标志 */
let seekClamping = false;

/** MSE 会话状态（非响应式，每次打开预览建立一个） */
interface MseSession {
  ms: MediaSource;
  objectUrl: string;
  sb: SourceBuffer | null;
  abort: AbortController | null;
  queue: Uint8Array[];
  appending: boolean;
  streamDone: boolean;
  evictRetried: boolean;
  onSourceOpen: (() => void) | null;
  onUpdateEnd: (() => void) | null;
  onSbError: (() => void) | null;
}
let mseSession: MseSession | null = null;

/** MediaSource 能力检测（存在性 + 指定 MIME 是否可解码） */
function mseTypeSupported(mime: string): boolean {
  if (typeof MediaSource === 'undefined' || typeof MediaSource.isTypeSupported !== 'function') {
    return false;
  }
  try { return MediaSource.isTypeSupported(mime); } catch { return false; }
}

/** 打开视频预览：MSE 优先，不支持时原生回退 */
function setupVideo() {
  const url = snap.src;
  if (!url) return;
  videoBuffering.value = true;
  videoBufferedRatio.value = 0;
  seekClamping = false;
  // mimeType 缺失时按常见 video/mp4 尝试，不支持则自动走回退
  const mime = snap.mimeType || 'video/mp4';
  if (mseTypeSupported(mime)) {
    startMseVideo(url, mime);
  } else {
    videoUseMse.value = false;
    videoSrc.value = url;
  }
}

function startMseVideo(url: string, mime: string) {
  const ms = new MediaSource();
  const s: MseSession = {
    ms,
    objectUrl: URL.createObjectURL(ms),
    sb: null,
    abort: null,
    queue: [],
    appending: false,
    streamDone: false,
    evictRetried: false,
    onSourceOpen: null,
    onUpdateEnd: null,
    onSbError: null,
  };
  mseSession = s;
  videoUseMse.value = true;
  videoSrc.value = s.objectUrl;

  s.onSourceOpen = () => {
    ms.removeEventListener('sourceopen', s.onSourceOpen as EventListener);
    if (mseSession !== s) return;
    try {
      const sb = ms.addSourceBuffer(mime);
      s.sb = sb;
      s.onUpdateEnd = () => {
        if (mseSession !== s) return;
        s.appending = false;
        s.evictRetried = false;
        pumpAppendQueue();
        maybeEndOfStream();
      };
      s.onSbError = () => {
        if (mseSession !== s) return;
        fallbackToNative();
      };
      sb.addEventListener('updateend', s.onUpdateEnd);
      sb.addEventListener('error', s.onSbError);
      void pumpMseStream(url);
    } catch {
      // addSourceBuffer 失败（容器格式不被支持等）→ 原生回退
      fallbackToNative();
    }
  };
  ms.addEventListener('sourceopen', s.onSourceOpen);
}

/**
 * 持续消费响应流直至读完——不随视频暂停而停止读取，
 * 保证后端「边消费边构建缓存」不会因客户端停读而背压暂停。
 */
async function pumpMseStream(url: string) {
  const s = mseSession;
  if (!s) return;
  const ctrl = new AbortController();
  s.abort = ctrl;
  try {
    const res = await fetch(url, { credentials: 'same-origin', signal: ctrl.signal });
    if (mseSession !== s) return;
    if (!res.ok) {
      // 无权 / 不存在：直接进错误态（原生回退同样会失败）
      teardownVideo();
      mediaError.value = true;
      return;
    }
    const body = res.body;
    if (!body) {
      fallbackToNative();
      return;
    }
    const reader = body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (mseSession !== s) return; // 已关闭 / 已降级
      if (done) break;
      s.queue.push(value);
      pumpAppendQueue();
    }
    s.streamDone = true;
    maybeEndOfStream();
  } catch {
    if (ctrl.signal.aborted || mseSession !== s) return;
    fallbackToNative();
  }
}

/** appendBuffer 串行队列：同一时刻只允许一次 append，updateend 后继续 */
function pumpAppendQueue() {
  const s = mseSession;
  if (!s || !s.sb || s.appending || s.queue.length === 0) return;
  if (s.sb.updating) return;
  const chunk = s.queue.shift()!;
  s.appending = true;
  try {
    s.sb.appendBuffer(chunk);
  } catch (e) {
    s.appending = false;
    onAppendError(e, chunk);
  }
}

/** QuotaExceededError：移除最早的缓冲区间后重试；仍失败则整体降级原生 */
function onAppendError(e: unknown, chunk: Uint8Array) {
  const s = mseSession;
  if (!s || !s.sb) return;
  const isQuota = e instanceof DOMException && e.name === 'QuotaExceededError';
  if (isQuota && !s.evictRetried && evictOldestBuffered(s.sb)) {
    s.evictRetried = true;
    s.queue.unshift(chunk); // remove 的 updateend 会驱动队列重试
    return;
  }
  fallbackToNative();
}

/** 移除最早的缓冲区间（不越过当前播放位置，避免播放中断） */
function evictOldestBuffered(sb: SourceBuffer): boolean {
  const v = videoRef.value;
  if (sb.updating || sb.buffered.length === 0) return false;
  const start = sb.buffered.start(0);
  let end = sb.buffered.end(0);
  if (v && v.currentTime > start) end = Math.min(end, Math.max(start, v.currentTime - 1));
  if (end <= start) return false;
  try { sb.remove(start, end); return true; } catch { return false; }
}

/** 流读完且追加队列排空后结束 MediaSource 流 */
function maybeEndOfStream() {
  const s = mseSession;
  if (!s || !s.streamDone || !s.sb) return;
  if (s.sb.updating || s.queue.length > 0) return;
  if (s.ms.readyState === 'open') {
    try { s.ms.endOfStream(); } catch { /* 已关闭则忽略 */ }
  }
}

/** MSE 失败/不支持时降级：<video> 直接吃原始地址（preload=auto） */
function fallbackToNative() {
  teardownMse();
  videoUseMse.value = false;
  videoSrc.value = snap.src;
  videoBuffering.value = true;
  nextTick(() => videoRef.value?.load());
}

/** 清理 MSE 会话：abort fetch、解绑事件、释放对象 URL */
function teardownMse() {
  const s = mseSession;
  mseSession = null;
  if (!s) return;
  s.abort?.abort();
  if (s.onSourceOpen) s.ms.removeEventListener('sourceopen', s.onSourceOpen as EventListener);
  if (s.sb) {
    if (s.onUpdateEnd) s.sb.removeEventListener('updateend', s.onUpdateEnd);
    if (s.onSbError) s.sb.removeEventListener('error', s.onSbError);
    if (s.ms.readyState === 'open' && !s.sb.updating) {
      try { s.ms.endOfStream(); } catch { /* 忽略 */ }
    }
  }
  s.queue.length = 0;
  URL.revokeObjectURL(s.objectUrl);
}

/** 关闭/卸载：终止视频流并清理（保持“关闭即卸载终止流”语义） */
function teardownVideo() {
  teardownMse();
  videoSrc.value = null;
  videoUseMse.value = false;
  videoBuffering.value = false;
  videoBufferedRatio.value = 0;
  seekClamping = false;
}

/** video error：MSE 模式先降级原生；原生模式再失败则进错误态 */
function onVideoError() {
  if (videoUseMse.value) {
    fallbackToNative();
    return;
  }
  mediaError.value = true;
}

/**
 * seek 钳制（MSE 与原生共用）：超出已缓冲末尾的 seek 被拉回，
 * 进度条因此只能在已缓冲范围内拖动。防循环标志避免 seeking 事件死循环。
 */
function onVideoSeeking() {
  const v = videoRef.value;
  if (!v || seekClamping) return;
  let maxEnd = 0;
  for (let i = 0; i < v.buffered.length; i++) {
    if (v.buffered.end(i) > maxEnd) maxEnd = v.buffered.end(i);
  }
  if (maxEnd <= 0) return; // 尚无任何缓冲，不钳制
  const limit = Math.max(0, maxEnd - 0.1);
  if (v.currentTime > limit) {
    seekClamping = true;
    v.currentTime = limit;
  }
}
function onVideoSeeked() {
  seekClamping = false;
}

/** 已缓冲进度估算（buffered 最大 end / duration） */
function updateBufferedRatio() {
  const v = videoRef.value;
  if (!v || !Number.isFinite(v.duration) || v.duration <= 0) return;
  let maxEnd = 0;
  for (let i = 0; i < v.buffered.length; i++) {
    if (v.buffered.end(i) > maxEnd) maxEnd = v.buffered.end(i);
  }
  videoBufferedRatio.value = Math.min(100, Math.round((maxEnd / v.duration) * 100));
}

/**
 * 文本预览：同源 fetch（自动携带会话 Cookie）后流式读取。
 * Content-Length 超过 2MB 或流式累积超限时立即停止，提示下载查看。
 * 使用非 fatal 解码器，编码异常时以替换字符展示而非抛错。
 */
async function loadText() {
  const url = snap.src;
  if (!url) {
    textError.value = '预览地址无效';
    return;
  }
  const token = ++loadToken;
  textLoading.value = true;
  try {
    const res = await fetch(url, { credentials: 'same-origin' });
    if (token !== loadToken) return;
    if (!res.ok) {
      textError.value = res.status === 401 || res.status === 403
        ? `访问凭证已失效，请重新输入密码（HTTP ${res.status}）`
        : `文件加载失败（HTTP ${res.status}）`;
      return;
    }
    const contentLength = Number(res.headers.get('Content-Length') || 0);
    if (contentLength > TEXT_PREVIEW_LIMIT) {
      textTooLarge.value = true;
      return;
    }
    const body = res.body;
    if (!body) {
      // 极少数浏览器不支持流式读取：整体读取后再校验大小
      const buf = await res.arrayBuffer();
      if (token !== loadToken) return;
      if (buf.byteLength > TEXT_PREVIEW_LIMIT) {
        textTooLarge.value = true;
        return;
      }
      textContent.value = new TextDecoder('utf-8', { fatal: false }).decode(buf);
      return;
    }
    const reader = body.getReader();
    const decoder = new TextDecoder('utf-8', { fatal: false });
    let received = 0;
    let result = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (token !== loadToken) { await reader.cancel().catch(() => {}); return; }
      if (done) break;
      received += value.byteLength;
      if (received > TEXT_PREVIEW_LIMIT) {
        await reader.cancel().catch(() => {});
        textTooLarge.value = true;
        return;
      }
      result += decoder.decode(value, { stream: true });
    }
    result += decoder.decode();
    textContent.value = result;
  } catch {
    if (token !== loadToken) return;
    textError.value = '网络错误，无法加载文件内容';
  } finally {
    if (token === loadToken) textLoading.value = false;
  }
}

/** 底部下载：优先使用父组件传入的 downloadUrl，否则用预览地址兜底 */
function handleDownload() {
  const url = snap.downloadUrl || snap.src;
  if (!url) return;
  triggerBrowserDownload(url, snap.name || undefined);
}

function formatSize(bytes: number): string {
  if (bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  let size = bytes;
  while (size >= 1024 && i < units.length - 1) { size /= 1024; i++; }
  return `${size.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}
</script>

<style scoped>
/* 全屏遮罩：风格与 FileContextMenu 的浮层体系保持一致 */
.fpv-overlay {
  position: fixed;
  inset: 0;
  z-index: 9998;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 24px;
  background: color-mix(in srgb, var(--seed-bg, #0b0d12) 72%, transparent);
  backdrop-filter: blur(8px);
}

.fpv-dialog {
  display: flex;
  flex-direction: column;
  width: min(960px, 100%);
  height: min(88vh, 100%);
  background: var(--color-bg-overlay);
  border: 1px solid var(--border-strong);
  border-radius: var(--radius-md);
  box-shadow: var(--shadow-lg), var(--shadow-glow);
  backdrop-filter: blur(12px);
  overflow: hidden;
}

.fpv-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 12px 16px;
  border-bottom: 1px solid var(--border-default);
  flex-shrink: 0;
}

.fpv-name {
  font-size: 14px;
  font-weight: 500;
  color: var(--text-primary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.fpv-close {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  flex-shrink: 0;
  background: transparent;
  border: none;
  border-radius: var(--radius-sm, 6px);
  color: var(--text-secondary);
  font-size: 16px;
  cursor: pointer;
  transition: background var(--duration-fast), color var(--duration-fast);
}
.fpv-close:hover {
  background: var(--color-accent-soft);
  color: var(--text-accent);
}

.fpv-body {
  flex: 1;
  min-height: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  overflow: auto;
  padding: 16px;
}

.fpv-image {
  max-width: 100%;
  max-height: 100%;
  object-fit: contain;
  border-radius: var(--radius-sm, 6px);
}

.fpv-video {
  max-width: 100%;
  max-height: 100%;
  border-radius: var(--radius-sm, 6px);
  outline: none;
}

.fpv-video-wrap {
  position: relative;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 100%;
  height: 100%;
}

/* 缓冲中提示（不拦截视频控件交互） */
.fpv-video-loading {
  position: absolute;
  top: 12px;
  left: 50%;
  transform: translateX(-50%);
  padding: 6px 14px;
  background: color-mix(in srgb, var(--seed-bg, #0b0d12) 72%, transparent);
  border: 1px solid var(--border-default);
  border-radius: var(--radius-md);
  pointer-events: none;
  font-size: 12px;
  color: var(--text-secondary);
  white-space: nowrap;
}

.fpv-audio {
  width: min(560px, 100%);
}

.fpv-pdf {
  width: 100%;
  height: 100%;
  border: none;
  border-radius: var(--radius-sm, 6px);
  background: #fff;
}

.fpv-text {
  align-self: stretch;
  width: 100%;
  margin: 0;
  overflow: auto;
  font-family: var(--font-mono);
  font-size: 12.5px;
  line-height: 1.6;
  color: var(--text-primary);
  white-space: pre-wrap;
  word-break: break-word;
  user-select: text;
}

/* 加载 / 错误兜底态 */
.fpv-state {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 12px;
  padding: 32px;
  text-align: center;
  color: var(--text-secondary);
  font-size: 14px;
}
.fpv-state p { margin: 0; }
.fpv-state-icon {
  font-size: 36px;
  color: var(--text-tertiary);
}
.fpv-error .fpv-state-icon { color: var(--color-danger); }

/* 通用小按钮（错误态下载 / 底部下载） */
.fpv-btn {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 7px 18px;
  background: var(--seed-primary);
  color: #fff;
  border: none;
  border-radius: var(--radius-md);
  font-size: 13px;
  font-family: inherit;
  cursor: pointer;
  transition: background 0.2s, transform 0.1s;
}
.fpv-btn:hover { background: color-mix(in srgb, var(--seed-primary) 85%, #fff); }
.fpv-btn:active { transform: scale(0.98); }

.fpv-footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 10px 16px;
  border-top: 1px solid var(--border-default);
  flex-shrink: 0;
}

.fpv-meta {
  font-size: 12px;
  color: var(--text-tertiary);
  font-family: var(--font-mono);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* 进出场动画 */
.fpv-fade-enter-active,
.fpv-fade-leave-active {
  transition: opacity var(--duration-fast, 0.15s);
}
.fpv-fade-enter-from,
.fpv-fade-leave-to {
  opacity: 0;
}
</style>
