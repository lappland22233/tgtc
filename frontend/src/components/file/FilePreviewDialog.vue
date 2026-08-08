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

            <!-- 视频 -->
            <video
              v-else-if="snap.kind === 'video' && snap.src && !mediaError"
              class="fpv-video"
              :src="snap.src"
              controls
              preload="metadata"
              @error="onMediaError"
            />

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
import { ref, reactive, watch, onUnmounted } from 'vue';
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
onUnmounted(() => window.removeEventListener('keydown', onKeydown));

function close() {
  emit('update:visible', false);
}

/** 媒体元素加载失败（含 401/403 无权访问） */
function onMediaError() {
  mediaError.value = true;
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
