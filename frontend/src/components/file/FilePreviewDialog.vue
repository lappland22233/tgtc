<template>
  <teleport to="body">
      <div
        v-show="visible"
        class="fpv-overlay"
        role="presentation"
        @click.self="close"
      >
        <div
          ref="dialogRef"
          class="fpv-dialog"
          :class="`fpv-dialog--${snap.kind || 'unknown'}`"
          role="dialog"
          aria-modal="true"
          :aria-label="snap.name || '文件预览'"
          @pointerdown="onDialogPointerDown"
        >
          <!-- 头部：文件名 + 播放列表导航 + 关闭 -->
          <div class="fpv-header">
            <div class="fpv-name" :title="snap.name">{{ snap.name || '文件预览' }}</div>
            <div class="fpv-header-actions">
              <!-- 播放列表导航 -->
              <template v-if="hasPlaylist && isMediaCollection">
                <span class="fpv-playlist-indicator">
                  {{ activeIndex + 1 }} / {{ playlist.length }}
                </span>
                <button
                  type="button"
                  class="fpv-nav-btn"
                  :disabled="!hasPrev"
                  :aria-label="`上一个${collectionItemLabel} (Shift+P)`"
                  title="上一个 (Shift+P)"
                  @click="playPrev"
                >
                  <t-icon name="chevron-left" />
                </button>
                <button
                  type="button"
                  class="fpv-nav-btn"
                  :disabled="!hasNext"
                  :aria-label="`下一个${collectionItemLabel} (Shift+N)`"
                  title="下一个 (Shift+N)"
                  @click="playNext"
                >
                  <t-icon name="chevron-right" />
                </button>
                <button
                  type="button"
                  class="fpv-nav-btn fpv-playlist-toggle"
                  :class="{ 'fpv-active': playlistOpen }"
                  aria-label="播放列表"
                  title="播放列表"
                  :aria-expanded="playlistOpen"
                  aria-controls="fpv-playlist-panel"
                  @click.stop="playlistOpen = !playlistOpen"
                >
                  <t-icon name="view-list" />
                </button>
              </template>
              <button type="button" class="fpv-close" aria-label="关闭预览" @click="close">
                <t-icon name="close" />
              </button>
            </div>
          </div>

          <!-- 内容区：按 kind 分支懒挂载（关闭卸载即终止媒体流） -->
          <div class="fpv-body">
            <!-- 图片 -->
            <img
              v-if="visible && snap.kind === 'image' && snap.src && !mediaError"
              class="fpv-image"
              :src="snap.src"
              :alt="snap.name"
              @error="onMediaError"
            />

            <!-- 视频：自定义播放器（MSE 优先，不支持时原生回退） -->
            <div
              v-else-if="visible && snap.kind === 'video' && snap.src && !mediaError"
              class="fpv-video-wrap"
            >
              <CustomVideoPlayer
                :src="videoSrc"
                :poster="snap.kind === 'video' ? posterUrl : null"
                :cold="coldLoad"
                :end-behavior="videoEndBehavior"
                @update:end-behavior="setVideoEndBehavior"
                @video-ref="onCustomPlayerVideoRef"
                @request-play="activateVideo"
                @ended="onVideoEnded"
                @error="onVideoError"
              />
            </div>

            <!-- 音频：主题化播放器卡片（保留原生 audio 控件的可访问性） -->
            <div
              v-else-if="visible && snap.kind === 'audio' && snap.src && !mediaError"
              class="fpv-audio-player"
            >
              <div class="fpv-audio-visual">
                <div class="fpv-audio-icon" aria-hidden="true">
                  <t-icon name="music" />
                </div>
                <div class="fpv-audio-info">
                  <div class="fpv-audio-name" :title="snap.name">{{ snap.name || '音频文件' }}</div>
                  <div class="fpv-audio-meta">
                    <template v-if="snap.mimeType">{{ snap.mimeType }}</template>
                    <template v-if="snap.size != null"> · {{ formatSize(snap.size) }}</template>
                  </div>
                </div>
              </div>
              <div class="fpv-audio-wave" :class="{ 'fpv-audio-wave--playing': audioPlaying }" aria-hidden="true">
                <span
                  v-for="(bar, idx) in audioWaveBars"
                  :key="idx"
                  :style="{ height: bar.height + '%' }"
                />
              </div>
              <audio
                ref="audioRef"
                class="fpv-audio-controls"
                :src="snap.src"
                controls
                preload="metadata"
                @play="onAudioPlay"
                @pause="onAudioPause"
                @ended="onAudioEnded"
                @error="onMediaError"
              />
            </div>

            <!-- PDF（浏览器原生内联渲染） -->
            <iframe
              v-else-if="visible && snap.kind === 'pdf' && snap.src"
              class="fpv-pdf"
              :src="snap.src"
              :title="snap.name || 'PDF 预览'"
            />

            <!-- 文本：打开时 fetch 读取 -->
            <template v-else-if="visible && snap.kind === 'text'">
              <div v-if="textLoading" class="fpv-state">
                <t-loading size="medium" text="正在加载文本内容…" />
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
              <div v-else class="fpv-text-panel">
                <div class="fpv-text-toolbar">
                  <div class="fpv-text-toolbar-left">
                    <t-icon name="file-code" class="fpv-text-type-icon" aria-hidden="true" />
                    <span class="fpv-text-type-label">文本文件</span>
                  </div>
                  <div class="fpv-text-toolbar-meta">
                    <template v-if="snap.mimeType"><span>{{ snap.mimeType }}</span></template>
                    <template v-if="snap.size != null"><span> · {{ formatSize(snap.size) }}</span></template>
                    <template v-if="textCharCount > 0"><span> · {{ textCharCount }} 字符</span></template>
                  </div>
                </div>
                <pre class="fpv-text">{{ textContent }}</pre>
              </div>
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

          <!-- 播放列表面板 -->
          <transition name="fpv-slide">
            <div
              v-if="playlistOpen && hasPlaylist"
              id="fpv-playlist-panel"
              ref="playlistPanelRef"
              class="fpv-playlist-panel"
              role="region"
              :aria-label="collectionTitle"
            >
              <div class="fpv-playlist-header">
                <span class="fpv-playlist-title">{{ collectionTitle }}</span>
                <span class="fpv-playlist-count">{{ playlist.length }} 个{{ collectionItemLabel }}</span>
                <button
                  type="button"
                  class="fpv-playlist-close"
                  aria-label="收起播放列表"
                  title="收起播放列表"
                  @click="playlistOpen = false"
                >
                  <t-icon name="close" />
                </button>
              </div>
              <div class="fpv-playlist-list">
                <div
                  v-for="(item, idx) in playlist"
                  :key="item.id"
                  class="fpv-playlist-item"
                  :class="{ 'fpv-playing': idx === activeIndex, 'fpv-playlist-item--image': snap.kind === 'image' }"
                  @click="switchToTrack(idx)"
                >
                  <ThumbnailImg
                    v-if="snap.kind === 'image'"
                    class="fpv-playlist-thumb"
                    :file-id="item.id"
                    :mime-type="item.mimeType"
                    :file-name="item.name"
                    :size="48"
                  />
                  <div v-else class="fpv-playlist-index">{{ idx + 1 }}</div>
                  <div class="fpv-playlist-info">
                    <div class="fpv-playlist-name" :title="item.name">{{ item.name }}</div>
                    <div class="fpv-playlist-meta">
                      {{ item.mimeType }}<template v-if="item.size"> · {{ formatSize(item.size) }}</template>
                    </div>
                  </div>
                  <div v-if="idx === activeIndex" class="fpv-playlist-now">
                    <t-icon name="sound" />
                  </div>
                </div>
              </div>
            </div>
          </transition>
        </div>
      </div>
  </teleport>
</template>

<script setup lang="ts">
import { ref, reactive, watch, nextTick, computed, onUnmounted } from 'vue';
import type { PreviewKind } from '../../utils/preview';
import {
  buildShareThumbnailUrl,
  buildShareHdThumbnailUrl,
  fetchFileCacheStatus,
  fetchShareCacheStatus,
} from '../../utils/preview';
import { triggerBrowserDownload } from '../../utils/download';
import { getThumbnailUrl, getHdThumbnailUrl } from '../../utils/thumbnailCache';
import CustomVideoPlayer, { type VideoEndBehavior } from './CustomVideoPlayer.vue';
import ThumbnailImg from '../ThumbnailImg.vue';

/** 播放列表项（父组件传入，FilePreviewDialog 不依赖 FileItem 类型） */
export interface PlaylistItem {
  id: string;
  name: string;
  mimeType: string;
  kind: 'image' | 'video' | 'audio';
  size?: number;
  src: string;
  downloadUrl?: string;
}

const props = withDefaults(defineProps<{
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
  /** 播放列表（同文件夹下的视频文件列表） */
  playlist?: PlaylistItem[];
  /** 当前播放在列表中的索引 */
  playlistIndex?: number;
  /** 当前文件 ID（登录态或分享态封面加载共用） */
  fileId?: string;
  /** 分享 token；存在时按分享封面/缓存状态链路加载 */
  shareToken?: string;
  /** 分享密码访问 JWT */
  shareAccessJwt?: string;
}>(), {
  playlist: () => [],
  playlistIndex: -1,
  fileId: '',
  shareToken: '',
  shareAccessJwt: '',
});

const emit = defineEmits<{
  'update:visible': [v: boolean];
  'update:playlist-index': [idx: number];
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
const dialogRef = ref<HTMLElement | null>(null);
const playlistPanelRef = ref<HTMLElement | null>(null);

// ============ 视频封面与冷资源加载状态 ============
/** 普通封面清晰度下限：宽度或高度低于任一值则升级到高清封面接口 */
const HD_COVER_MIN_WIDTH = 640;
const HD_COVER_MIN_HEIGHT = 360;

/** 视频封面 Object URL（封面只请求一次，再由 video poster 复用本地 Blob） */
const posterUrl = ref<string | null>(null);
/** 当前封面所属文件 ID（播放列表切换时更新） */
const currentPosterFileId = ref('');
/** 封面异步加载代次，防止切换文件后旧结果覆盖新状态 */
let posterLoadToken = 0;
/** 是否已尝试过高清封面升级（避免普通/高清封面循环重试） */
let hdCoverAttempted = false;
/** 封面加载失败后的重试计数（冷资源缓存完成前只补一次） */
let posterRetryCount = 0;
let posterRetryTimer: ReturnType<typeof setTimeout> | null = null;
/** 冷资源加载模式：文件尚未缓存时钳制 seek，避免动态分段请求 */
const coldLoad = ref(false);

function clearPosterRetryTimer() {
  if (!posterRetryTimer) return;
  clearTimeout(posterRetryTimer);
  posterRetryTimer = null;
}

function setPosterObjectUrl(url: string | null) {
  const previous = posterUrl.value;
  posterUrl.value = url;
  if (previous?.startsWith('blob:') && previous !== url) URL.revokeObjectURL(previous);
}

// ============ 播放列表状态 ============
const hasPlaylist = computed(() => props.playlist.length > 1);
const isMediaCollection = computed(() => snap.kind === 'video' || snap.kind === 'audio' || snap.kind === 'image');
const collectionItemLabel = computed(() => snap.kind === 'audio' ? '音乐' : snap.kind === 'image' ? '图片' : '视频');
const collectionTitle = computed(() => snap.kind === 'audio' ? '音乐播放列表' : snap.kind === 'image' ? '图片列表' : '视频播放列表');
const playlistOpen = ref(false);
const playlistIndexInternal = ref(-1);
const VIDEO_END_BEHAVIOR_KEY = 'file-preview-video-end-behavior';
const VIDEO_END_BEHAVIORS: readonly VideoEndBehavior[] = ['loop', 'next', 'pause'];
const videoEndBehavior = ref<VideoEndBehavior>(loadVideoEndBehavior());
let autoNextTimer: ReturnType<typeof setTimeout> | null = null;

function loadVideoEndBehavior(): VideoEndBehavior {
  try {
    const saved = localStorage.getItem(VIDEO_END_BEHAVIOR_KEY);
    if (VIDEO_END_BEHAVIORS.includes(saved as VideoEndBehavior)) return saved as VideoEndBehavior;
  } catch { /* 隐私模式或存储被禁用时使用默认值 */ }
  return 'next';
}

function setVideoEndBehavior(behavior: VideoEndBehavior) {
  videoEndBehavior.value = behavior;
  try { localStorage.setItem(VIDEO_END_BEHAVIOR_KEY, behavior); } catch { /* 不影响播放 */ }
}

function clearAutoNextTimer() {
  if (!autoNextTimer) return;
  clearTimeout(autoNextTimer);
  autoNextTimer = null;
}

/** 当前播放项在列表中的索引（优先用 props.playlistIndex，否则内部追踪） */
const activeIndex = computed(() => {
  if (props.playlistIndex >= 0) return props.playlistIndex;
  return playlistIndexInternal.value;
});

const hasPrev = computed(() => activeIndex.value > 0);
const hasNext = computed(() => activeIndex.value < props.playlist.length - 1);

/** 切换到列表中指定项 */
function switchToTrack(idx: number) {
  if (idx < 0 || idx >= props.playlist.length) return;
  clearAutoNextTimer();
  const item = props.playlist[idx];
  playlistOpen.value = false;
  playlistIndexInternal.value = idx;
  emit('update:playlist-index', idx);
  // 更新快照并按媒体类型重新加载。
  resetState();
  snap.name = item.name;
  snap.mimeType = item.mimeType;
  snap.size = item.size ?? null;
  snap.kind = item.kind;
  snap.src = item.src;
  snap.downloadUrl = item.downloadUrl ?? null;
  mediaError.value = false;
  if (item.kind === 'video') {
    // 封面与冷资源状态跟随播放项切换
    currentPosterFileId.value = item.id;
    setPosterObjectUrl(null);
    hdCoverAttempted = false;
    posterRetryCount = 0;
    coldLoad.value = false;
    void checkColdStatus();
    void loadPoster();
  }
  if (item.kind === 'audio') nextTick(() => { void audioRef.value?.play().catch(() => {}); });
}

function playPrev() { if (hasPrev.value) switchToTrack(activeIndex.value - 1); }
function playNext() { if (hasNext.value) switchToTrack(activeIndex.value + 1); }

/** 播放列表展开后，点击面板之外的弹窗区域立即收起，不遮挡媒体。 */
function onDialogPointerDown(event: PointerEvent) {
  if (!playlistOpen.value) return;
  const target = event.target as Node | null;
  if (target && playlistPanelRef.value?.contains(target)) return;
  const toggle = (target as Element | null)?.closest?.('.fpv-playlist-toggle');
  if (toggle) return;
  playlistOpen.value = false;
}

/** 根据用户选择处理视频结束：单集循环、自动下一个或停在结尾。 */
function onVideoEnded() {
  clearAutoNextTimer();
  if (videoEndBehavior.value === 'loop') {
    const video = videoRef.value;
    if (!video) return;
    video.currentTime = 0;
    void video.play().catch(() => {});
    return;
  }
  if (videoEndBehavior.value === 'next' && hasNext.value) {
    autoNextTimer = setTimeout(() => {
      autoNextTimer = null;
      playNext();
    }, 800);
  }
}

/** 初始化时根据 src 在列表中定位当前索引 */
watch(() => [props.visible, props.src], ([vis, src]) => {
  if (!vis || !src || props.playlist.length === 0) return;
  if (props.playlistIndex >= 0) {
    playlistIndexInternal.value = props.playlistIndex;
  } else {
    const idx = props.playlist.findIndex((p) => p.src === src);
    if (idx >= 0) playlistIndexInternal.value = idx;
  }
});

/** 文本预览大小上限：2MB（响应头超限或流式累积超限均停止读取） */
const TEXT_PREVIEW_LIMIT = 2 * 1024 * 1024;
/** 加载令牌：避免快速开关时旧请求结果覆盖新状态 */
let loadToken = 0;
let textAbort: AbortController | null = null;
const audioRef = ref<HTMLAudioElement | null>(null);

/** 音频是否正在播放（驱动波形装饰动画） */
const audioPlaying = ref(false);
const AUDIO_WAVE_BAR_COUNT = 28;
const audioWaveBars = ref(Array.from({ length: AUDIO_WAVE_BAR_COUNT }, () => ({ height: 28 })));
let audioContext: AudioContext | null = null;
let audioAnalyser: AnalyserNode | null = null;
let audioSource: MediaElementAudioSourceNode | null = null;
let audioWaveFrame = 0;
let audioWaveData: Uint8Array | null = null;

function stopAudioWaveform() {
  if (audioWaveFrame) cancelAnimationFrame(audioWaveFrame);
  audioWaveFrame = 0;
  audioSource?.disconnect();
  audioAnalyser?.disconnect();
  audioSource = null;
  audioAnalyser = null;
  audioWaveData = null;
  if (audioContext) void audioContext.close().catch(() => {});
  audioContext = null;
  audioWaveBars.value = Array.from({ length: AUDIO_WAVE_BAR_COUNT }, () => ({ height: 28 }));
}

function updateAudioWaveform() {
  if (!audioPlaying.value || !audioAnalyser || !audioWaveData) return;
  audioAnalyser.getByteTimeDomainData(audioWaveData as any);
  const bucketSize = Math.max(1, Math.floor(audioWaveData.length / AUDIO_WAVE_BAR_COUNT));
  audioWaveBars.value = Array.from({ length: AUDIO_WAVE_BAR_COUNT }, (_, index) => {
    const start = index * bucketSize;
    const end = Math.min(audioWaveData!.length, start + bucketSize);
    let peak = 0;
    for (let i = start; i < end; i++) peak = Math.max(peak, Math.abs(audioWaveData![i] - 128));
    return { height: Math.min(100, Math.max(28, 28 + peak * 2.4)) };
  });
  audioWaveFrame = requestAnimationFrame(updateAudioWaveform);
}

function setupAudioWaveform() {
  const audio = audioRef.value;
  if (!audio || audioAnalyser) return;
  try {
    audioContext = new AudioContext();
    audioAnalyser = audioContext.createAnalyser();
    audioAnalyser.fftSize = 256;
    audioWaveData = new Uint8Array(audioAnalyser.frequencyBinCount);
    audioSource = audioContext.createMediaElementSource(audio);
    audioSource.connect(audioAnalyser);
    audioAnalyser.connect(audioContext.destination);
  } catch {
    stopAudioWaveform();
  }
}

function onAudioPlay() {
  audioPlaying.value = true;
  setupAudioWaveform();
  if (audioContext?.state === 'suspended') void audioContext.resume();
  if (!audioWaveFrame) audioWaveFrame = requestAnimationFrame(updateAudioWaveform);
}
function onAudioPause() {
  audioPlaying.value = false;
  if (audioWaveFrame) cancelAnimationFrame(audioWaveFrame);
  audioWaveFrame = 0;
}
function onAudioEnded() {
  onAudioPause();
  if (hasNext.value) switchToTrack(activeIndex.value + 1);
}

/** 文本内容字符数（工具栏信息展示） */
const textCharCount = computed(() => textContent.value.length);

function resetState() {
  loadToken++;
  textAbort?.abort();
  textAbort = null;
  clearAutoNextTimer();
  clearPosterRetryTimer();
  posterLoadToken++;
  teardownVideo();
  stopAudioWaveform();
  const audio = audioRef.value;
  if (audio) {
    audio.pause();
    audio.removeAttribute('src');
    audio.load();
  }
  audioPlaying.value = false;
  textLoading.value = false;
  textContent.value = '';
  textError.value = null;
  textTooLarge.value = false;
  mediaError.value = false;
  // 关闭/切换时清空封面与冷资源状态，避免下一文件残留
  setPosterObjectUrl(null);
  currentPosterFileId.value = '';
  coldLoad.value = false;
  hdCoverAttempted = false;
  posterRetryCount = 0;
}

/** Esc 键关闭 + 播放列表快捷键 */
function onKeydown(e: KeyboardEvent) {
  if (!props.visible) return;
  if (e.key === 'Escape') {
    if (playlistOpen.value) playlistOpen.value = false;
    else close();
    return;
  }
  // Shift+N / Shift+P → 当前媒体列表的下一项 / 上一项
  if (e.shiftKey && hasPlaylist.value) {
    if (e.key === 'N' || e.key === 'n') { e.preventDefault(); playNext(); }
    if (e.key === 'P' || e.key === 'p') { e.preventDefault(); playPrev(); }
  }
}
watch(() => props.visible, (v) => {
  if (v) window.addEventListener('keydown', onKeydown);
  else window.removeEventListener('keydown', onKeydown);
});
onUnmounted(() => {
  window.removeEventListener('keydown', onKeydown);
  textAbort?.abort();
  teardownVideo();
});

/** 请求父组件关闭；同步收起播放列表，避免下次打开时保留遮挡状态。 */
function close() {
  playlistOpen.value = false;
  emit('update:visible', false);
}

/** 媒体元素加载失败（含 401/403 无权访问） */
function onMediaError() {
  mediaError.value = true;
}

// ============ 视频预览（MSE 优先 + 原生回退） ============
const videoRef = ref<HTMLVideoElement | null>(null);

/**
 * 从 CustomVideoPlayer 获取内部 <video> 元素引用。
 * 绑定 MSE 所需的事件监听（seek 钳制 + 缓冲追踪）。
 */
function onCustomPlayerVideoRef(el: HTMLVideoElement | null) {
  // 清理旧监听
  const old = videoRef.value;
  if (old) {
    old.removeEventListener('seeking', onVideoSeeking);
    old.removeEventListener('seeked', onVideoSeeked);
    old.removeEventListener('progress', updateBufferedRatio);
    old.removeEventListener('timeupdate', updateBufferedRatio);
  }
  videoRef.value = el;
  if (el) {
    el.addEventListener('seeking', onVideoSeeking);
    el.addEventListener('seeked', onVideoSeeked);
    el.addEventListener('progress', updateBufferedRatio);
    el.addEventListener('timeupdate', updateBufferedRatio);
  }
}
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
  /** SourceBuffer 仅接受基于 ArrayBuffer 的 BufferSource，避免 ArrayBufferLike 类型歧义 */
  queue: ArrayBuffer[];
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

/** 用户首次明确播放后才激活真实媒体源。 */
function activateVideo() {
  if (videoSrc.value || !snap.src) return;
  setupVideo();
}

/** 激活视频预览：MSE 优先，不支持时原生回退 */
function setupVideo() {
  const url = snap.src;
  if (!url) return;
  videoBuffering.value = true;
  videoBufferedRatio.value = 0;
  seekClamping = false;
  // mimeType 缺失时按常见 video/mp4 尝试，不支持则自动走回退
  const mime = snap.mimeType || 'video/mp4';
  // 默认统一交给原生媒体元素按需发起 Range。保留旧 MSE 实现仅用于后续分段化改造，
  // 当前显式禁用，因为它会持续读取至 EOF，且无法按时间点重新请求已驱逐片段。
  const enableLegacyMse = false;
  if (enableLegacyMse && mseTypeSupported(mime)) {
    startMseVideo(url, mime);
    return;
  }
  videoUseMse.value = false;
  videoSrc.value = url;
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
      // ReadableStream 的 value 类型为 Uint8Array<ArrayBufferLike>；复制后得到独立 ArrayBuffer，
      // 满足 SourceBuffer.appendBuffer(BufferSource) 的严格 DOM 类型约束。
      s.queue.push(new Uint8Array(value).buffer);
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
function onAppendError(e: unknown, chunk: ArrayBuffer) {
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

/** 关闭/卸载：终止视频流并清理（保持”关闭即卸载终止流”语义） */
function teardownVideo() {
  teardownMse();
  // 清理解码器侧绑定的事件监听
  const v = videoRef.value;
  if (v) {
    v.removeEventListener('seeking', onVideoSeeking);
    v.removeEventListener('seeked', onVideoSeeked);
    v.removeEventListener('progress', updateBufferedRatio);
    v.removeEventListener('timeupdate', updateBufferedRatio);
  }
  videoRef.value = null;
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
  // 冷资源全量下载完成（整段已缓冲）→ 退出冷模式并补一次封面重试
  if (coldLoad.value && maxEnd >= v.duration - 0.5) {
    coldLoad.value = false;
    void retryPosterAfterCache();
  }
}

// ============ 视频封面加载（复用封面接口 + 低清自动升级高清） ============
/** 单次请求封面并转为本地 Object URL；尺寸检测和 video poster 共用该本地资源。 */
async function fetchPosterResource(url: string): Promise<{
  objectUrl: string;
  width: number;
  height: number;
} | null> {
  try {
    const response = await fetch(url, { credentials: 'same-origin' });
    if (!response.ok) return null;
    const objectUrl = URL.createObjectURL(await response.blob());
    const dimensions = await new Promise<{ width: number; height: number } | null>((resolve) => {
      const img = new Image();
      img.onload = () => resolve({ width: img.naturalWidth, height: img.naturalHeight });
      img.onerror = () => resolve(null);
      img.src = objectUrl;
    });
    if (!dimensions) {
      URL.revokeObjectURL(objectUrl);
      return null;
    }
    return { objectUrl, ...dimensions };
  } catch {
    return null;
  }
}

/** 判断当前文件是否属于分享预览链路 */
function isShareContext(): boolean {
  return !!props.shareToken;
}

/** 当前封面任务是否仍属于可见的同一视频。 */
function isCurrentPosterTask(fid: string, token: number): boolean {
  return props.visible
    && snap.kind === 'video'
    && currentPosterFileId.value === fid
    && posterLoadToken === token;
}

/** 查询当前视频是否为冷资源（尚无正式缓存），决定是否开启 seek 钳制 */
async function checkColdStatus() {
  const fid = currentPosterFileId.value;
  const stateToken = loadToken;
  if (!fid) return;
  const cached = isShareContext()
    ? await fetchShareCacheStatus(props.shareToken, fid, props.shareAccessJwt || undefined)
    : await fetchFileCacheStatus(fid);
  if (!props.visible || snap.kind !== 'video' || currentPosterFileId.value !== fid || loadToken !== stateToken) return;
  coldLoad.value = !cached;
}

/** 加载视频封面：每个候选封面只请求一次，检测低分辨率后一次性升级高清封面。 */
async function loadPoster() {
  const fid = currentPosterFileId.value;
  const token = ++posterLoadToken;
  if (!fid || snap.kind !== 'video' || !props.visible) return;

  const standardUrl = isShareContext()
    ? buildShareThumbnailUrl(props.shareToken, fid, props.shareAccessJwt || undefined)
    : await getThumbnailUrl(fid, 'video/mp4');
  if (!standardUrl || !isCurrentPosterTask(fid, token)) return;

  const standard = await fetchPosterResource(standardUrl);
  if (!isCurrentPosterTask(fid, token)) {
    if (standard) URL.revokeObjectURL(standard.objectUrl);
    return;
  }
  if (!standard) {
    setPosterObjectUrl(null);
    return;
  }

  setPosterObjectUrl(standard.objectUrl);
  if (standard.width >= HD_COVER_MIN_WIDTH && standard.height >= HD_COVER_MIN_HEIGHT) return;
  if (hdCoverAttempted) return;

  hdCoverAttempted = true;
  const hdUrl = isShareContext()
    ? buildShareHdThumbnailUrl(props.shareToken, fid, props.shareAccessJwt || undefined)
    : await getHdThumbnailUrl(fid, 'video/mp4');
  if (!hdUrl || !isCurrentPosterTask(fid, token)) return;

  const hd = await fetchPosterResource(hdUrl);
  if (!isCurrentPosterTask(fid, token)) {
    if (hd) URL.revokeObjectURL(hd.objectUrl);
    return;
  }
  if (hd) setPosterObjectUrl(hd.objectUrl);
}

/** 冷资源缓存完成后补一次封面加载（此时普通/高清封面通常已可生成） */
function retryPosterAfterCache() {
  if (posterRetryCount >= 1) return;
  posterRetryCount++;
  hdCoverAttempted = false;
  clearPosterRetryTimer();
  posterRetryTimer = setTimeout(() => {
    posterRetryTimer = null;
    if (!props.visible) return;
    void loadPoster();
  }, 800);
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
  textAbort?.abort();
  const ctrl = new AbortController();
  textAbort = ctrl;
  textLoading.value = true;
  try {
    const res = await fetch(url, { credentials: 'same-origin', signal: ctrl.signal });
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
    if (ctrl.signal.aborted || token !== loadToken) return;
    textError.value = '网络错误，无法加载文件内容';
  } finally {
    if (textAbort === ctrl) textAbort = null;
    if (token === loadToken) textLoading.value = false;
  }
}

/**
 * 必须在全部媒体状态变量初始化后注册。immediate watcher 会同步执行，
 * 若提前注册，resetState() 会访问仍处于暂时性死区的 mseSession 等变量。
 */
watch(() => props.visible, (v) => {
  resetState();
  playlistOpen.value = false;
  if (v) {
    snap.name = props.name || '';
    snap.mimeType = props.mimeType || '';
    snap.size = props.size ?? null;
    snap.kind = props.kind;
    snap.src = props.src;
    snap.downloadUrl = props.downloadUrl ?? null;
    if (props.kind === 'text') void loadText();
    if (props.kind === 'video') {
      // 封面与冷资源状态：打开时查询缓存并加载普通封面
      currentPosterFileId.value = props.fileId || '';
      setPosterObjectUrl(null);
      hdCoverAttempted = false;
      posterRetryCount = 0;
      coldLoad.value = false;
      void checkColdStatus();
      void loadPoster();
    }
  }
}, { immediate: true });

/** 底部下载：优先使用父组件传入的 downloadUrl，否则用预览地址兜底 */
function handleDownload() {
  const url = snap.downloadUrl || snap.src;
  if (!url) return;
  triggerBrowserDownload(url, snap.name || undefined);
}

/**
 * 安全的文件大小格式化。
 * 后端/调用方可能传入字符串、空值或非法数值（如 `size` 以字符串形式返回时，
 * 直接调用 `.toFixed` 会抛 `p.toFixed is not a function`），统一先做数值归一化。
 */
function formatSize(bytes: number | string | null | undefined): string {
  const num = Number(bytes);
  if (!Number.isFinite(num) || num <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  let size = num;
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
  position: relative;
  display: flex;
  flex-direction: column;
  width: min(960px, calc(100vw - 48px));
  height: min(88dvh, 860px);
  max-height: calc(100dvh - 48px);
  background: var(--color-bg-overlay);
  border: 1px solid var(--border-strong);
  border-radius: var(--radius-md);
  box-shadow: var(--shadow-lg), var(--shadow-glow);
  backdrop-filter: blur(12px);
  overflow: hidden;
}

/* 不同媒体类型使用不同画布比例，减少小媒体留白并扩大文档可视区域 */
.fpv-dialog--video {
  width: min(1120px, calc(100vw - 48px));
  height: min(86dvh, 760px);
}

.fpv-dialog--image {
  width: min(1040px, calc(100vw - 48px));
  height: min(88dvh, 900px);
}

.fpv-dialog--pdf,
.fpv-dialog--text {
  width: min(1180px, calc(100vw - 48px));
  height: min(92dvh, 960px);
}

.fpv-dialog--audio {
  width: min(640px, calc(100vw - 48px));
  height: auto;
  max-height: calc(100dvh - 48px);
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
  overscroll-behavior: contain;
  padding: 16px;
}

.fpv-image {
  display: block;
  width: auto;
  height: auto;
  max-width: 100%;
  max-height: 100%;
  object-fit: contain;
  border-radius: var(--radius-sm, 6px);
}

.fpv-video-wrap {
  position: relative;
  width: 100%;
  height: 100%;
  min-height: 0;
  display: grid;
  place-items: center;
  overflow: hidden;
  background: #000;
  border-radius: var(--radius-sm, 6px);
}

/* CustomVideoPlayer 填满可用画布，内部 object-fit: contain 保持任意视频比例 */
.fpv-video-wrap > :deep(.cvp) {
  width: 100%;
  height: 100%;
  min-height: 0;
  aspect-ratio: auto;
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

/* ═══════════════ 音频播放器卡片 ═══════════════ */
.fpv-audio-player {
  width: min(560px, 100%);
  padding: 24px 24px 20px;
  background:
    linear-gradient(160deg, color-mix(in srgb, var(--seed-primary) 7%, transparent), transparent 55%),
    var(--color-bg-elevated);
  border: 1px solid var(--border-default);
  border-radius: var(--radius-lg);
  box-shadow: var(--shadow-sm);
  display: flex;
  flex-direction: column;
  gap: 18px;
}

.fpv-audio-visual {
  display: flex;
  align-items: center;
  gap: 16px;
  min-width: 0;
}

/* 左侧媒体图标：主色渐变底 + 波形装饰 */
.fpv-audio-icon {
  position: relative;
  display: grid;
  place-items: center;
  width: 64px;
  height: 64px;
  flex-shrink: 0;
  border-radius: var(--radius-lg);
  background:
    radial-gradient(circle at 30% 22%, color-mix(in srgb, var(--seed-primary) 38%, transparent), transparent 58%),
    linear-gradient(145deg, color-mix(in srgb, var(--seed-primary) 16%, var(--seed-surface)), color-mix(in srgb, var(--seed-accent) 12%, var(--seed-surface)));
  border: 1px solid var(--border-accent);
  color: var(--seed-primary);
  font-size: 30px;
  overflow: hidden;
}

.fpv-audio-info {
  min-width: 0;
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.fpv-audio-name {
  font-size: 15px;
  font-weight: 600;
  color: var(--text-primary);
  line-height: 1.35;
  overflow: hidden;
  text-overflow: ellipsis;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
}

.fpv-audio-meta {
  display: flex;
  align-items: center;
  gap: 2px;
  font-family: var(--font-mono);
  font-size: 12px;
  color: var(--text-tertiary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* 波形装饰：由 Web Audio API 实时驱动 */
.fpv-audio-wave {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 3px;
  height: 34px;
  padding: 0 4px;
  border-top: 1px dashed var(--border-default);
  border-bottom: 1px dashed var(--border-default);
  opacity: 0.9;
}

.fpv-audio-wave span {
  width: 3px;
  min-height: 4px;
  border-radius: 999px;
  background: color-mix(in srgb, var(--seed-primary) 62%, transparent);
  transform-origin: center;
}

.fpv-audio-wave--playing span {
  animation: fpv-wave 1.1s ease-in-out infinite;
}

.fpv-audio-wave--playing span:nth-child(3n) { animation-duration: 1.35s; }
.fpv-audio-wave--playing span:nth-child(4n) { animation-duration: 0.9s; }

@keyframes fpv-wave {
  0%, 100% { transform: scaleY(0.35); }
  50% { transform: scaleY(1); }
}

/* 原生 audio 控件：占满播放器卡片宽度 */
.fpv-audio-controls {
  display: block;
  width: 100%;
  height: 44px;
}
.fpv-audio-controls:focus-visible {
  outline: 2px solid var(--seed-primary);
  outline-offset: 2px;
  border-radius: var(--radius-sm);
}

/* ═══════════════ 文本预览面板 ═══════════════ */
.fpv-text-panel {
  align-self: stretch;
  width: 100%;
  height: 100%;
  min-height: 0;
  display: flex;
  flex-direction: column;
  background: var(--color-bg-elevated);
  border: 1px solid var(--border-default);
  border-radius: var(--radius-md);
  overflow: hidden;
}

.fpv-text-toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 8px 14px;
  border-bottom: 1px solid var(--border-default);
  background: color-mix(in srgb, var(--seed-primary) 4%, var(--color-bg-overlay));
  flex-shrink: 0;
}

.fpv-text-toolbar-left {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
}

.fpv-text-type-icon {
  font-size: 16px;
  color: var(--seed-primary);
  flex-shrink: 0;
}

.fpv-text-type-label {
  font-size: 12px;
  font-weight: 500;
  color: var(--text-primary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.fpv-text-toolbar-meta {
  display: flex;
  align-items: center;
  gap: 2px;
  font-family: var(--font-mono);
  font-size: 11px;
  font-variant-numeric: tabular-nums;
  color: var(--text-tertiary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  flex-shrink: 1;
}

.fpv-text {
  flex: 1;
  min-height: 0;
  margin: 0;
  overflow: auto;
  overscroll-behavior: contain;
  padding: 14px 16px;
  font-family: var(--font-mono);
  font-size: 12.5px;
  line-height: 1.7;
  color: var(--text-primary);
  tab-size: 4;
  white-space: pre-wrap;
  word-break: break-word;
  user-select: text;
}

/* 文本阅读区滚动条 */
.fpv-text::-webkit-scrollbar { width: 8px; height: 8px; }
.fpv-text::-webkit-scrollbar-track { background: transparent; }
.fpv-text::-webkit-scrollbar-thumb { background: var(--border-strong); border-radius: 4px; }
.fpv-text::-webkit-scrollbar-thumb:hover { background: var(--text-tertiary); }

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

/* 头部右侧操作区 */
.fpv-header-actions {
  display: flex;
  align-items: center;
  gap: 4px;
  flex-shrink: 0;
}

.fpv-playlist-indicator {
  font-size: 12px;
  font-weight: 500;
  color: var(--text-tertiary);
  font-family: var(--font-mono);
  padding: 0 6px;
  white-space: nowrap;
}

.fpv-nav-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  background: transparent;
  border: none;
  border-radius: var(--radius-sm, 6px);
  color: var(--text-secondary);
  font-size: 16px;
  cursor: pointer;
  transition: background var(--duration-fast), color var(--duration-fast);
}
.fpv-nav-btn:hover:not(:disabled) {
  background: var(--color-accent-soft);
  color: var(--text-accent);
}
.fpv-nav-btn:disabled {
  color: var(--text-quaternary, #999);
  cursor: default;
  opacity: 0.5;
}
.fpv-nav-btn.fpv-active {
  color: var(--seed-primary);
  background: var(--color-accent-soft);
}

/* 播放列表面板 */
.fpv-playlist-panel {
  position: absolute;
  top: 0;
  right: 0;
  bottom: 0;
  width: 280px;
  max-width: 80%;
  background: var(--color-bg-overlay);
  border-left: 1px solid var(--border-default);
  display: flex;
  flex-direction: column;
  z-index: 10;
}

.fpv-playlist-header {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 12px 14px;
  border-bottom: 1px solid var(--border-default);
  flex-shrink: 0;
}

.fpv-playlist-title {
  font-size: 13px;
  font-weight: 500;
  color: var(--text-primary);
}

.fpv-playlist-count {
  font-size: 11px;
  color: var(--text-tertiary);
}

.fpv-playlist-close {
  display: inline-grid;
  place-items: center;
  width: 30px;
  height: 30px;
  margin-left: auto;
  border: 0;
  border-radius: var(--radius-sm, 6px);
  background: transparent;
  color: var(--text-secondary);
  cursor: pointer;
}

.fpv-playlist-close:hover {
  background: var(--color-accent-soft);
  color: var(--text-accent);
}

.fpv-playlist-list {
  flex: 1;
  overflow-y: auto;
  padding: 6px 0;
  scrollbar-width: thin;
  scrollbar-color: var(--border-default) transparent;
}
.fpv-playlist-list::-webkit-scrollbar { width: 4px; }
.fpv-playlist-list::-webkit-scrollbar-track { background: transparent; }
.fpv-playlist-list::-webkit-scrollbar-thumb { background: var(--border-default); border-radius: 2px; }

.fpv-playlist-item {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 14px;
  cursor: pointer;
  transition: background 0.15s;
  position: relative;
}
.fpv-playlist-item:hover {
  background: var(--color-accent-soft);
}
.fpv-playlist-item.fpv-playing {
  background: color-mix(in srgb, var(--seed-primary) 8%, transparent);
}
.fpv-playlist-item.fpv-playing::before {
  content: '';
  position: absolute;
  left: 0;
  top: 6px;
  bottom: 6px;
  width: 3px;
  background: var(--seed-primary);
  border-radius: 0 2px 2px 0;
}

.fpv-playlist-thumb {
  width: 48px;
  height: 48px;
  flex: 0 0 48px;
  object-fit: cover;
  border-radius: var(--radius-sm, 6px);
  background: var(--color-bg-secondary);
  border: 1px solid var(--border-default);
}

.fpv-playlist-item--image {
  min-height: 64px;
}

.fpv-playlist-index {
  width: 20px;
  font-size: 11px;
  font-weight: 500;
  color: var(--text-quaternary, #999);
  text-align: center;
  flex-shrink: 0;
  font-family: var(--font-mono);
}

.fpv-playlist-info {
  flex: 1;
  min-width: 0;
}

.fpv-playlist-name {
  font-size: 12px;
  font-weight: 500;
  color: var(--text-primary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  line-height: 1.4;
}
.fpv-playing .fpv-playlist-name {
  color: var(--seed-primary);
}

.fpv-playlist-meta {
  font-size: 11px;
  color: var(--text-tertiary);
  margin-top: 1px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.fpv-playlist-now {
  color: var(--seed-primary);
  font-size: 16px;
  flex-shrink: 0;
}

/* 播放列表滑入动画 */
.fpv-slide-enter-active,
.fpv-slide-leave-active {
  transition: transform var(--duration-fast, 0.15s) ease, opacity var(--duration-fast, 0.15s) ease;
}
.fpv-slide-enter-from,
.fpv-slide-leave-to {
  transform: translateX(100%);
  opacity: 0;
}

@media (max-width: 720px) {
  .fpv-overlay {
    align-items: stretch;
    padding: max(8px, env(safe-area-inset-top)) max(8px, env(safe-area-inset-right)) max(8px, env(safe-area-inset-bottom)) max(8px, env(safe-area-inset-left));
  }

  .fpv-dialog,
  .fpv-dialog--video,
  .fpv-dialog--image,
  .fpv-dialog--pdf,
  .fpv-dialog--text,
  .fpv-dialog--audio {
    width: 100%;
    height: 100%;
    max-height: none;
    border-radius: var(--radius-sm, 6px);
  }

  .fpv-header {
    min-height: 48px;
    padding: 8px 10px;
  }

  .fpv-name {
    font-size: 13px;
  }

  .fpv-playlist-indicator {
    display: none;
  }

  .fpv-nav-btn,
  .fpv-close {
    width: 36px;
    height: 36px;
  }

  .fpv-body {
    padding: 8px;
  }

  .fpv-dialog--audio .fpv-body {
    min-height: 160px;
  }

  .fpv-audio-player {
    padding: 18px 16px 16px;
  }

  .fpv-audio-icon {
    width: 52px;
    height: 52px;
    font-size: 26px;
  }

  .fpv-audio-name {
    font-size: 14px;
  }

  .fpv-audio-wave {
    height: 28px;
    gap: 2px;
  }

  .fpv-audio-wave span {
    width: 2px;
  }

  .fpv-text {
    padding: 12px;
    font-size: 12px;
  }

  .fpv-text-toolbar {
    padding: 6px 10px;
    flex-wrap: wrap;
  }

  .fpv-text-toolbar-meta {
    font-size: 10px;
  }

  .fpv-footer {
    padding: 8px 10px;
  }

  .fpv-playlist-panel {
    top: auto;
    width: 100%;
    max-width: none;
    max-height: min(62%, 520px);
    border-top: 1px solid var(--border-default);
    border-left: 0;
    box-shadow: 0 -12px 32px rgba(0, 0, 0, 0.28);
  }

  .fpv-slide-enter-from,
  .fpv-slide-leave-to {
    transform: translateY(100%);
  }
}

@media (max-height: 560px) and (orientation: landscape) {
  .fpv-overlay {
    padding: 8px;
  }

  .fpv-dialog,
  .fpv-dialog--video,
  .fpv-dialog--image,
  .fpv-dialog--pdf,
  .fpv-dialog--text,
  .fpv-dialog--audio {
    width: min(1100px, 100%);
    height: 100%;
    max-height: none;
  }

  .fpv-header,
  .fpv-footer {
    padding-block: 6px;
  }

  .fpv-body {
    padding: 6px;
  }
}

@media (prefers-reduced-motion: reduce) {
  .fpv-slide-enter-active,
  .fpv-slide-leave-active {
    transition: none;
  }

  .fpv-audio-wave--playing span {
    animation: none;
  }
}
</style>
