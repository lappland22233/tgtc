<template>
  <div
    ref="playerRef"
    class="cvp"
    :class="{
      'cvp--paused': isPaused,
      'cvp--playing': !isPaused,
      'cvp--controls-visible': controlsVisible,
      'cvp--buffering': isBuffering,
      'cvp--fullscreen': isFullscreen,
    }"
    @mousemove="onMouseMove"
    @mouseleave="onMouseLeave"
    @click.self="togglePlay"
  >
    <!-- 视频元素 -->
    <video
      ref="videoRef"
      class="cvp__video"
      :src="src || undefined"
      :poster="poster || undefined"
      preload="none"
      playsinline
      @play="onPlay"
      @pause="onPause"
      @ended="onEnded"
      @timeupdate="onTimeUpdate"
      @loadedmetadata="onLoadedMeta"
      @durationchange="onDurationChange"
      @progress="onProgress"
      @waiting="isBuffering = true"
      @canplay="isBuffering = false"
      @playing="isBuffering = false"
      @error="onError"
      @click="togglePlay"
      @dblclick.prevent="toggleFullscreen"
    />

    <!-- 中央播放按钮（暂停/结束时显示） -->
    <button
      v-show="isPaused || isEnded"
      class="cvp__center-play"
      aria-label="播放"
      @click.stop="togglePlay"
    >
      <svg viewBox="0 0 24 24" width="32" height="32"><path d="M8 5v14l11-7z" fill="currentColor"/></svg>
    </button>

    <!-- 缓冲指示器 -->
    <div v-if="isBuffering" class="cvp__buffering">
      <div class="cvp__spinner" />
      <span class="cvp__buffer-text">{{ bufferText }}</span>
    </div>

    <!-- 中央速度指示器（长按方向键 3x 时） -->
    <transition name="cvp-fade">
      <div v-if="speedIndicatorVisible" class="cvp__speed-indicator">{{ speedIndicatorText }}</div>
    </transition>

    <!-- 中央 seek 指示器 -->
    <transition name="cvp-fade">
      <div v-if="seekIndicator" class="cvp__seek-indicator" :class="`cvp__seek-indicator--${seekIndicator.dir}`">
        {{ seekIndicator.text }}
      </div>
    </transition>

    <!-- 底部控制栏 -->
    <div class="cvp__controls" @click.stop>
      <!-- 进度条 -->
      <div
        class="cvp__progress"
        :class="{ 'cvp__progress--dragging': isDragging }"
        role="slider"
        tabindex="0"
        aria-label="视频进度"
        :aria-valuemin="0"
        :aria-valuemax="Math.max(0, Math.round(duration))"
        :aria-valuenow="Math.max(0, Math.round(currentTime))"
        :aria-valuetext="`${formatTime(currentTime)} / ${formatTime(duration)}`"
        @keydown.left.prevent="seekBy(-5)"
        @keydown.right.prevent="seekBy(5)"
        @pointerdown="onProgressPointerDown"
        @pointermove="onProgressPointerMove"
        @pointerup="onProgressPointerUp"
        @pointercancel="onProgressPointerCancel"
        @mousemove="onProgressHover"
      >
        <div class="cvp__progress-track">
          <div class="cvp__progress-buffered" :style="{ width: bufferedPct + '%' }" />
          <div class="cvp__progress-played" :style="{ width: playedPct + '%' }" />
        </div>
        <div class="cvp__progress-thumb" :style="{ left: playedPct + '%' }" />
        <div
          v-if="tooltipVisible"
          class="cvp__progress-tooltip"
          :style="{ left: tooltipLeft + '%' }"
        >{{ tooltipTime }}</div>
      </div>

      <!-- 控制按钮行 -->
      <div class="cvp__btn-row">
        <!-- 播放/暂停 -->
        <button class="cvp__btn cvp__btn--play" :aria-label="isPaused ? '播放' : '暂停'" @click="togglePlay">
          <svg v-if="isPaused" viewBox="0 0 24 24" width="22" height="22"><path d="M8 5v14l11-7z" fill="currentColor"/></svg>
          <svg v-else viewBox="0 0 24 24" width="22" height="22"><path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z" fill="currentColor"/></svg>
        </button>

        <!-- 音量 -->
        <div class="cvp__volume" @mouseenter="volumeHover = true" @mouseleave="volumeHover = false">
          <button class="cvp__btn" :aria-label="isMuted ? '取消静音' : '静音'" @click="toggleMute">
            <svg v-if="isMuted || volume === 0" viewBox="0 0 24 24" width="20" height="20"><path d="M16.5 12A4.5 4.5 0 0 0 14 8.5v2.09l2.41 2.41c.06-.31.09-.63.09-1zM19 12c0 .94-.2 1.82-.54 2.64l1.51 1.51A8.796 8.796 0 0 0 21 12c0-4.28-2.99-7.86-7-8.77v2.06c2.89.86 5 3.54 5 6.71zM4.27 3L3 4.27 7.73 9H3v6h4l5 5v-6.73l4.25 4.25c-.67.52-1.42.93-2.25 1.18v2.06a8.99 8.99 0 0 0 3.69-1.81L19.73 21 21 19.73l-9-9L4.27 3zM12 4L9.91 6.09 12 8.18V4z" fill="currentColor"/></svg>
            <svg v-else-if="volume < 0.5" viewBox="0 0 24 24" width="20" height="20"><path d="M18.5 12A4.5 4.5 0 0 0 16 8.5v7a4.47 4.47 0 0 0 2.5-3.5zM3 9v6h4l5 5V4L7 9H3z" fill="currentColor"/></svg>
            <svg v-else viewBox="0 0 24 24" width="20" height="20"><path d="M3 9v6h4l5 5V4L7 9H3zm13.5 3A4.5 4.5 0 0 0 14 8.5v7a4.47 4.47 0 0 0 2.5-3.5zM14 3.23v2.06c2.89.86 5 3.54 5 6.71s-2.11 5.85-5 6.71v2.06c4.01-.91 7-4.49 7-8.77s-2.99-7.86-7-8.77z" fill="currentColor"/></svg>
          </button>
          <div class="cvp__volume-slider-wrap">
            <input
              type="range"
              class="cvp__volume-slider"
              min="0"
              max="1"
              step="0.01"
              :value="isMuted ? 0 : volume"
              @input="onVolumeInput"
              aria-label="音量"
            />
          </div>
        </div>

        <!-- 时间 -->
        <span class="cvp__time">
          <span class="cvp__time-current">{{ formatTime(currentTime) }}</span>
          <span class="cvp__time-sep"> / </span>
          <span class="cvp__time-duration">{{ formatTime(duration) }}</span>
        </span>

        <span class="cvp__spacer" />

        <!-- 播放结束行为 -->
        <div class="cvp__end-behavior-wrap">
          <button
            class="cvp__btn cvp__btn--end-behavior"
            aria-haspopup="menu"
            :aria-expanded="endBehaviorMenuOpen"
            :aria-label="`播放结束行为：${currentEndBehaviorLabel}`"
            :title="`播放结束：${currentEndBehaviorLabel}`"
            @click.stop="toggleEndBehaviorMenu"
          >
            <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
              <path v-if="endBehavior === 'loop'" d="M17 2l4 4-4 4V7H7a3 3 0 0 0-3 3v1H2v-1a5 5 0 0 1 5-5h10V2zm0 15H7v3l-4-4 4-4v3h10a3 3 0 0 0 3-3v-1h2v1a5 5 0 0 1-5 5z" fill="currentColor"/>
              <path v-else-if="endBehavior === 'next'" d="M6 5v14l9-7-9-7zm10 0h2v14h-2V5z" fill="currentColor"/>
              <path v-else d="M7 7h10v10H7V7z" fill="currentColor"/>
            </svg>
            <span>{{ currentEndBehaviorLabel }}</span>
          </button>
          <transition name="cvp-fade">
            <div v-if="endBehaviorMenuOpen" class="cvp__end-behavior-menu" role="menu" aria-label="播放结束行为">
              <button
                v-for="option in endBehaviorOptions"
                :key="option.value"
                type="button"
                role="menuitemradio"
                :aria-checked="option.value === endBehavior"
                class="cvp__end-behavior-item"
                :class="{ 'cvp__end-behavior-item--active': option.value === endBehavior }"
                @click="setEndBehavior(option.value)"
              >
                <span>{{ option.label }}</span>
                <svg v-if="option.value === endBehavior" viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path d="M9 16.2 4.8 12l-1.4 1.4L9 19 21 7l-1.4-1.4L9 16.2z" fill="currentColor"/></svg>
              </button>
            </div>
          </transition>
        </div>

        <!-- 播放速度 -->
        <div class="cvp__speed-wrap">
          <button
            class="cvp__btn cvp__btn--speed"
            aria-haspopup="menu"
            :aria-expanded="speedMenuOpen"
            aria-label="播放速度"
            @click.stop="speedMenuOpen = !speedMenuOpen"
          >
            {{ currentSpeed === 1 ? '1×' : currentSpeed + '×' }}
          </button>
          <transition name="cvp-fade">
            <div v-if="speedMenuOpen" class="cvp__speed-menu" role="menu" aria-label="播放速度">
              <button
                v-for="s in speedOptions"
                :key="s"
                type="button"
                role="menuitemradio"
                :aria-checked="s === currentSpeed"
                class="cvp__speed-item"
                :class="{ 'cvp__speed-item--active': s === currentSpeed }"
                @click="setSpeed(s)"
              >{{ s === 1 ? '1×  正常' : s + '×' }}</button>
            </div>
          </transition>
        </div>

        <!-- 全屏 -->
        <button class="cvp__btn" :aria-label="isFullscreen ? '退出全屏' : '全屏'" @click="toggleFullscreen">
          <svg v-if="!isFullscreen" viewBox="0 0 24 24" width="20" height="20"><path d="M7 14H5v5h5v-2H7v-3zm-2-4h2V7h3V5H5v5zm12 7h-3v2h5v-5h-2v3zM14 5v2h3v3h2V5h-5z" fill="currentColor"/></svg>
          <svg v-else viewBox="0 0 24 24" width="20" height="20"><path d="M5 16h3v3h2v-5H5v2zm3-8H5v2h5V5H8v3zm6 11h2v-3h3v-2h-5v5zm2-11V5h-2v5h5V8h-3z" fill="currentColor"/></svg>
        </button>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, watch, onMounted, onBeforeUnmount } from 'vue';
import { useVideoPlayerState } from '../../composables/useVideoPlayerState';
import MessagePlugin from '@/utils/message';

export type VideoEndBehavior = 'loop' | 'next' | 'pause';

const props = withDefaults(defineProps<{
  /** 视频 src（可以是普通 URL 或 MediaSource ObjectURL） */
  src: string | null;
  /** 视频封面（poster）URL，冷资源未生成时可为空 */
  poster?: string | null;
  /**
   * 冷资源加载模式：文件尚未有正式本地缓存时开启。
   * 开启后所有 seek（进度条/键盘/快捷键）都被钳制到已缓冲末尾，
   * 避免浏览器为越界位置发起新的动态分段请求。
   */
  cold?: boolean;
  /** 播放结束后的行为，由预览弹窗统一执行 */
  endBehavior?: VideoEndBehavior;
  /**
   * 打开 / 切换媒体时待恢复的播放进度（秒）。
   * 仅在媒体元数据可用后应用一次；src 变化后重置，允许新媒体重新恢复。
   */
  initialTime?: number;
  /**
   * 是否处于可交互状态（如完整预览已展开）。
   * 收起为迷你播放器后禁用全局键盘快捷键，避免影响用户对页面的正常操作。
   */
  interactive?: boolean;
}>(), {
  endBehavior: 'next',
  poster: null,
  cold: false,
  initialTime: 0,
  interactive: true,
});

const emit = defineEmits<{
  play: [];
  pause: [];
  ended: [];
  error: [];
  'request-play': [];
  'update:end-behavior': [behavior: VideoEndBehavior];
  /** 暴露 video 元素引用给父组件（用于 MSE 等外部控制） */
  'video-ref': [el: HTMLVideoElement | null];
}>();

// ─── Refs ────────────────────────────
const playerRef = ref<HTMLElement>();
const videoRef = ref<HTMLVideoElement | null>(null);

// ─── State（播放/进度/指示器/持久化/延迟恢复） ───
const playerState = useVideoPlayerState({
  getVideoRef: () => videoRef.value,
  getCold: () => props.cold,
  getInitialTime: () => props.initialTime,
});
const {
  isPaused,
  isEnded,
  isBuffering,
  currentTime,
  duration,
  volume,
  isMuted,
  currentSpeed,
  controlsVisible,
  speedMenuOpen,
  endBehaviorMenuOpen,
  volumeHover,
  playedPct,
  bufferedPct,
  isDragging,
  dragPct,
  tooltipVisible,
  tooltipLeft,
  tooltipTime,
  speedIndicatorVisible,
  speedIndicatorText,
  seekIndicator,
  isFullscreen,
  DEFAULT_VIDEO_VOLUME,
  saveVolume,
  saveRate,
  clampSeekTarget,
  cancelDeferredResume,
  applyInitialTime,
  resetInitialTime,
  tryDeferredResume,
  onFullscreenChange,
  formatTime,
} = playerState;

const speedOptions = [0.5, 1, 1.25, 1.5, 2, 3];
const endBehaviorOptions: Array<{ value: VideoEndBehavior; label: string; shortLabel: string }> = [
  { value: 'loop', label: '单集循环', shortLabel: '循环' },
  { value: 'next', label: '自动下一个', shortLabel: '连播' },
  { value: 'pause', label: '播完暂停', shortLabel: '暂停' },
];

const currentEndBehaviorLabel = computed(() => (
  endBehaviorOptions.find((option) => option.value === props.endBehavior)?.shortLabel ?? '连播'
));

let hideTimer: ReturnType<typeof setTimeout> | null = null;
let seekHideTimer: ReturnType<typeof setTimeout> | null = null;
let pendingPlayRequest = false;
let playFrame: number | null = null;
let progressPointerCapture: { element: HTMLElement; pointerId: number } | null = null;
let longPressActive = false;
let savedRate = 1;

const bufferText = computed(() => {
  if (bufferedPct.value > 0) {
    const base = `正在缓冲…（已缓冲 ${Math.round(bufferedPct.value)}%）`;
    // 冷资源：seek 受限于已缓冲范围，缓存完成前无法跳转到未缓冲位置
    return props.cold ? `${base}，缓存完成前无法跳转` : base;
  }
  return props.cold ? '正在生成缓存…完成后可跳转' : '正在缓冲…';
});

// ─── 视频事件处理 ────────────────────────────
function onPlay() {
  isPaused.value = false;
  isEnded.value = false;
  emit('play');
  resetHideTimer();
}

function onPause() {
  isPaused.value = true;
  emit('pause');
  showControls();
}

function onEnded() {
  isEnded.value = true;
  isPaused.value = true;
  emit('ended');
  showControls();
}

function onError() {
  emit('error');
}

function onTimeUpdate() {
  const v = videoRef.value;
  if (!v || isDragging.value) return;
  currentTime.value = v.currentTime;
  playedPct.value = duration.value > 0 ? (v.currentTime / duration.value) * 100 : 0;
}

function onLoadedMeta() {
  const v = videoRef.value;
  if (!v) return;
  duration.value = v.duration;
  applyInitialTime(v);
}

function onDurationChange() {
  const v = videoRef.value;
  if (v && isFinite(v.duration)) duration.value = v.duration;
}

function onProgress() {
  const v = videoRef.value;
  if (!v || !v.buffered.length || !duration.value) return;
  let maxEnd = 0;
  for (let i = 0; i < v.buffered.length; i++) {
    if (v.buffered.end(i) > maxEnd) maxEnd = v.buffered.end(i);
  }
  bufferedPct.value = Math.min(100, (maxEnd / duration.value) * 100);
  // 冷资源延迟恢复：buffered 覆盖恢复点后执行一次 seek
  tryDeferredResume();
}

// ─── 播放控制 ────────────────────────────
function togglePlay() {
  const v = videoRef.value;
  if (!v) return;
  if (!props.src) {
    if (!pendingPlayRequest) {
      pendingPlayRequest = true;
      emit('request-play');
    }
    isBuffering.value = true;
    showControls();
    return;
  }
  if (v.paused || v.ended) {
    v.play().catch(() => {});
  } else {
    v.pause();
  }
  showControls();
}

function toggleMute() {
  const v = videoRef.value;
  if (!v) return;
  v.muted = !v.muted;
  isMuted.value = v.muted;
  if (!v.muted && v.volume === 0) {
    v.volume = DEFAULT_VIDEO_VOLUME;
    volume.value = DEFAULT_VIDEO_VOLUME;
    saveVolume(DEFAULT_VIDEO_VOLUME);
  }
}

function onVolumeInput(e: Event) {
  const v = videoRef.value;
  if (!v) return;
  const val = parseFloat((e.target as HTMLInputElement).value);
  v.volume = val;
  v.muted = false;
  volume.value = val;
  isMuted.value = false;
}

function setSpeed(s: number) {
  const v = videoRef.value;
  if (!v) return;
  v.playbackRate = s;
  currentSpeed.value = s;
  saveRate(s);
  speedMenuOpen.value = false;
}

function toggleEndBehaviorMenu() {
  endBehaviorMenuOpen.value = !endBehaviorMenuOpen.value;
  if (endBehaviorMenuOpen.value) speedMenuOpen.value = false;
}

function setEndBehavior(behavior: VideoEndBehavior) {
  emit('update:end-behavior', behavior);
  endBehaviorMenuOpen.value = false;
  showControls();
}

function toggleFullscreen() {
  const el = playerRef.value;
  const v = videoRef.value;
  if (!el) return;
  if (document.fullscreenElement) {
    document.exitFullscreen().catch(() => {});
    return;
  }
  // iOS Safari 不支持标准 Fullscreen API，回退到 video.webkitEnterFullscreen
  if (!el.requestFullscreen && v && typeof (v as any).webkitEnterFullscreen === 'function') {
    try { (v as any).webkitEnterFullscreen(); return; } catch { /* fallthrough */ }
  }
  const elAny = el as HTMLElement & { webkitRequestFullscreen?: () => Promise<void> | void };
  const req = el.requestFullscreen?.() ?? elAny.webkitRequestFullscreen?.();
  if (req && typeof req.catch === 'function') {
    req.catch(() => {
      // 全屏请求被拒绝（如 iOS 无法进入）→ 提示，不静默失败
      try { MessagePlugin.warning('当前浏览器不支持全屏'); } catch { /* 无反馈通道则忽略 */ }
    });
  }
}

// ─── 进度条交互 ────────────────────────────
function previewSeekPct(pct: number) {
  if (!duration.value) return;
  dragPct.value = pct;
  currentTime.value = (pct / 100) * duration.value;
  playedPct.value = pct;
}

function commitSeekPct(pct: number) {
  const v = videoRef.value;
  if (!v || !duration.value) return;
  const target = clampSeekTarget((pct / 100) * duration.value);
  // 冷资源且尚无任何缓冲时不允许跳转（此时任何位置都不可读）
  if (props.cold && target <= 0) {
    dragPct.value = null;
    return;
  }
  // fastSeek 允许浏览器选择邻近关键帧，普通赋值作为兼容回退。
  // 冷资源阶段直接用 currentTime 赋值，避免 fastSeek 跳到缓冲区间之外的关键帧。
  if (!props.cold && typeof v.fastSeek === 'function') v.fastSeek(target);
  else v.currentTime = target;
  currentTime.value = target;
  playedPct.value = duration.value > 0 ? (target / duration.value) * 100 : 0;
  dragPct.value = null;
}

function seekBy(seconds: number) {
  const v = videoRef.value;
  if (!v || !duration.value) return;
  const rawTarget = Math.max(0, Math.min(duration.value, v.currentTime + seconds));
  const target = clampSeekTarget(rawTarget);
  // 冷资源且目标被钳制到 0（尚无缓冲）时仅更新指示器，不真正 seek
  v.currentTime = target;
  currentTime.value = target;
  playedPct.value = (target / duration.value) * 100;
  showSeekIndicator(seconds < 0 ? 'back' : 'fwd', Math.abs(seconds));
  showControls();
}

function getPctFromEvent(e: MouseEvent | Touch | PointerEvent): number {
  const bar = playerRef.value?.querySelector('.cvp__progress') as HTMLElement;
  if (!bar) return 0;
  const rect = bar.getBoundingClientRect();
  return Math.max(0, Math.min(100, ((e.clientX - rect.left) / rect.width) * 100));
}

function onProgressPointerDown(e: PointerEvent) {
  if (!duration.value) return;
  const bar = e.currentTarget as HTMLElement;
  isDragging.value = true;
  bar.setPointerCapture?.(e.pointerId);
  progressPointerCapture = { element: bar, pointerId: e.pointerId };
  previewSeekPct(getPctFromEvent(e));
  showControls();
}

function onProgressPointerMove(e: PointerEvent) {
  if (!isDragging.value) return;
  const bar = e.currentTarget as HTMLElement;
  if (bar.hasPointerCapture?.(e.pointerId)) {
    e.preventDefault();
    previewSeekPct(getPctFromEvent(e));
  }
}

function finishProgressPointer(e: PointerEvent, commit: boolean) {
  if (!isDragging.value) return;
  const bar = e.currentTarget as HTMLElement;
  const targetPct = dragPct.value;
  if (commit && targetPct != null) commitSeekPct(targetPct);
  else dragPct.value = null;
  isDragging.value = false;
  if (bar.hasPointerCapture?.(e.pointerId)) {
    try { bar.releasePointerCapture(e.pointerId); } catch { /* 捕获已释放 */ }
  }
  progressPointerCapture = null;
  resetHideTimer();
}

function onProgressPointerUp(e: PointerEvent) {
  finishProgressPointer(e, true);
}

function onProgressPointerCancel(e: PointerEvent) {
  finishProgressPointer(e, false);
}

function onProgressHover(e: MouseEvent) {
  if (!duration.value) return;
  const pct = getPctFromEvent(e);
  tooltipLeft.value = pct;
  tooltipTime.value = formatTime((pct / 100) * duration.value);
  tooltipVisible.value = true;

  const bar = e.currentTarget as HTMLElement;
  const onLeave = () => { tooltipVisible.value = false; bar.removeEventListener('mouseleave', onLeave); };
  bar.addEventListener('mouseleave', onLeave);
}

// ─── 控制栏自动隐藏 ────────────────────────────
function showControls() {
  controlsVisible.value = true;
  resetHideTimer();
}

function resetHideTimer() {
  if (hideTimer) clearTimeout(hideTimer);
  hideTimer = setTimeout(() => {
    if (!isPaused.value && !speedMenuOpen.value && !endBehaviorMenuOpen.value && !isDragging.value) {
      controlsVisible.value = false;
    }
  }, 3000);
}

function onMouseMove() { showControls(); }
function onMouseLeave() {
  if (!isPaused.value && !speedMenuOpen.value && !endBehaviorMenuOpen.value) {
    if (hideTimer) clearTimeout(hideTimer);
    hideTimer = setTimeout(() => { controlsVisible.value = false; }, 1200);
  }
}

// ─── Seek 指示器 ────────────────────────────
function showSeekIndicator(dir: 'back' | 'fwd', seconds: number) {
  seekIndicator.value = { dir, text: `${dir === 'back' ? '−' : '+'}${seconds}s` };
  if (seekHideTimer) clearTimeout(seekHideTimer);
  seekHideTimer = setTimeout(() => { seekIndicator.value = null; }, 600);
}

// ─── 键盘快捷键 ────────────────────────────
function onKeydown(e: KeyboardEvent) {
  const v = videoRef.value;
  if (!v || e.defaultPrevented) return;
  const target = e.target as HTMLElement | null;
  const tag = target?.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target?.isContentEditable) return;

  switch (e.key.toLowerCase()) {
    case ' ':
    case 'k':
      e.preventDefault();
      togglePlay();
      break;
    case 'ArrowLeft':
      e.preventDefault();
      if (e.repeat) {
        if (!longPressActive) {
          longPressActive = true;
          savedRate = v.playbackRate;
          v.playbackRate = 3;
          speedIndicatorText.value = '3×';
          speedIndicatorVisible.value = true;
        }
      } else {
        seekBy(-5);
      }
      showControls();
      break;
    case 'ArrowRight':
      e.preventDefault();
      if (e.repeat) {
        if (!longPressActive) {
          longPressActive = true;
          savedRate = v.playbackRate;
          v.playbackRate = 3;
          speedIndicatorText.value = '3×';
          speedIndicatorVisible.value = true;
        }
      } else {
        seekBy(5);
      }
      showControls();
      break;
    case 'j':
      e.preventDefault();
      seekBy(-10);
      break;
    case 'l':
      e.preventDefault();
      seekBy(10);
      break;
    case 'ArrowUp':
      e.preventDefault();
      v.volume = Math.min(1, v.volume + 0.05);
      v.muted = false;
      volume.value = v.volume;
      isMuted.value = false;
      showControls();
      break;
    case 'ArrowDown':
      e.preventDefault();
      v.volume = Math.max(0, v.volume - 0.05);
      volume.value = v.volume;
      showControls();
      break;
    case 'm':
      e.preventDefault();
      toggleMute();
      showControls();
      break;
    case 'f':
      e.preventDefault();
      toggleFullscreen();
      break;
  }
}

function onKeyup(e: KeyboardEvent) {
  const v = videoRef.value;
  if (!v) return;
  if ((e.key === 'ArrowLeft' || e.key === 'ArrowRight') && longPressActive) {
    longPressActive = false;
    v.playbackRate = savedRate;
    currentSpeed.value = savedRate;
    speedIndicatorVisible.value = false;
  }
}

// ─── 生命周期 ────────────────────────────
watch(() => props.src, (src) => {
  const v = videoRef.value;
  if (!v) return;
  resetInitialTime(); // 新 src 允许应用新的恢复点
  cancelDeferredResume(); // 新 src 清除旧的待恢复位置
  currentTime.value = 0;
  playedPct.value = 0;
  bufferedPct.value = 0;
  isEnded.value = false;
  isPaused.value = true;
  if (playFrame !== null) {
    cancelAnimationFrame(playFrame);
    playFrame = null;
  }
  if (src && pendingPlayRequest) {
    pendingPlayRequest = false;
    const targetVideo = v;
    playFrame = requestAnimationFrame(() => {
      playFrame = null;
      if (videoRef.value === targetVideo && props.src === src) {
        void targetVideo.play().catch(() => { isBuffering.value = false; });
      }
    });
  } else if (!src) {
    pendingPlayRequest = false;
    isBuffering.value = false;
  }
});

// 暴露 video 元素给父组件
watch(videoRef, (el) => { emit('video-ref', el); }, { immediate: true });

// 点击菜单之外区域时收起播放器弹出菜单
function onClickOutsideMenus(e: MouseEvent) {
  const target = e.target as HTMLElement;
  if (speedMenuOpen.value && !target.closest('.cvp__speed-wrap')) {
    speedMenuOpen.value = false;
  }
  if (endBehaviorMenuOpen.value && !target.closest('.cvp__end-behavior-wrap')) {
    endBehaviorMenuOpen.value = false;
  }
}

/** 收起为迷你播放器（非交互态）时移除全局快捷键，避免干扰页面操作 */
function bindGlobalListeners(on: boolean) {
  if (on) {
    window.addEventListener('keydown', onKeydown);
    window.addEventListener('keyup', onKeyup);
  } else {
    window.removeEventListener('keydown', onKeydown);
    window.removeEventListener('keyup', onKeyup);
  }
}

onMounted(() => {
  const video = videoRef.value;
  if (video) {
    video.volume = volume.value;
    video.muted = false;
    // 恢复上次倍速
    video.playbackRate = currentSpeed.value;
  }
  bindGlobalListeners(props.interactive);
  document.addEventListener('fullscreenchange', onFullscreenChange);
  document.addEventListener('click', onClickOutsideMenus);
  // 初始显示控制栏，3s 后若播放中则隐藏
  showControls();
});

watch(() => props.interactive, (on) => {
  bindGlobalListeners(on);
});

onBeforeUnmount(() => {
  bindGlobalListeners(false);
  cancelDeferredResume();
  isDragging.value = false;
  dragPct.value = null;
  tooltipVisible.value = false;
  if (progressPointerCapture) {
    const { element, pointerId } = progressPointerCapture;
    if (element.hasPointerCapture?.(pointerId)) {
      try { element.releasePointerCapture(pointerId); } catch { /* 捕获已释放 */ }
    }
    progressPointerCapture = null;
  }
  document.removeEventListener('fullscreenchange', onFullscreenChange);
  document.removeEventListener('click', onClickOutsideMenus);
  if (hideTimer) { clearTimeout(hideTimer); hideTimer = null; }
  if (seekHideTimer) { clearTimeout(seekHideTimer); seekHideTimer = null; }
});

// 暴露方法供父组件调用
defineExpose({
  videoRef,
  togglePlay,
  play: () => videoRef.value?.play(),
  pause: () => videoRef.value?.pause(),
  /** 置 autoplay 意图：src 就绪（src watch）后自动播放，用于切换连播续播 */
  requestAutoplay: () => { pendingPlayRequest = true; },
});
</script>

<style scoped>
/* ═══════════════════════════════════════════════════════
   Custom Video Player (cvp) — 毛玻璃控制栏
   ═══════════════════════════════════════════════════════ */
.cvp {
  position: relative;
  width: 100%;
  height: 100%;
  background: #000;
  border-radius: var(--radius-sm, 6px);
  overflow: hidden;
  user-select: none;
  -webkit-user-select: none;
  cursor: default;
}

.cvp--fullscreen {
  position: fixed !important;
  inset: 0 !important;
  z-index: 99999 !important;
  border-radius: 0;
  width: 100vw !important;
  height: 100vh !important;
}

/* ─── 视频 ─── */
.cvp__video {
  width: 100%;
  height: 100%;
  object-fit: contain;
  display: block;
  outline: none;
}

/* ─── 中央播放按钮 ─── */
.cvp__center-play {
  position: absolute;
  top: 50%;
  left: 50%;
  transform: translate(-50%, -50%);
  width: 64px;
  height: 64px;
  border-radius: 50%;
  border: 1px solid rgba(255, 255, 255, 0.12);
  background: rgba(0, 0, 0, 0.55);
  backdrop-filter: blur(16px);
  -webkit-backdrop-filter: blur(16px);
  color: rgba(255, 255, 255, 0.92);
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  z-index: 15;
  transition: transform 0.2s var(--ease-out, cubic-bezier(0.16, 1, 0.3, 1)),
              background 0.15s ease;
  box-shadow: 0 8px 32px rgba(0, 0, 0, 0.3);
}
.cvp__center-play:hover {
  background: rgba(0, 0, 0, 0.65);
  transform: translate(-50%, -50%) scale(1.06);
}
.cvp__center-play:active {
  transform: translate(-50%, -50%) scale(0.92);
}

/* ─── 缓冲指示器 ─── */
.cvp__buffering {
  position: absolute;
  top: 50%;
  left: 50%;
  transform: translate(-50%, -50%);
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
  z-index: 18;
  pointer-events: none;
}
.cvp__spinner {
  width: 32px;
  height: 32px;
  border: 2.5px solid rgba(255, 255, 255, 0.15);
  border-top-color: rgba(255, 255, 255, 0.85);
  border-radius: 50%;
  animation: cvp-spin 0.75s linear infinite;
}
@keyframes cvp-spin { to { transform: rotate(360deg); } }
.cvp__buffer-text {
  font-size: 12px;
  font-weight: 500;
  color: rgba(255, 255, 255, 0.7);
  letter-spacing: 0.01em;
}

/* ─── 速度指示器 ─── */
.cvp__speed-indicator {
  position: absolute;
  top: 50%;
  left: 50%;
  transform: translate(-50%, -50%);
  padding: 8px 20px;
  border-radius: var(--radius-lg, 12px);
  background: rgba(0, 0, 0, 0.6);
  backdrop-filter: blur(16px);
  -webkit-backdrop-filter: blur(16px);
  border: 1px solid rgba(255, 255, 255, 0.1);
  font-size: 24px;
  font-weight: 600;
  color: var(--seed-primary, #0972D3);
  letter-spacing: -0.02em;
  z-index: 18;
  pointer-events: none;
}

/* ─── Seek 指示器 ─── */
.cvp__seek-indicator {
  position: absolute;
  top: 50%;
  transform: translateY(-50%);
  padding: 6px 14px;
  border-radius: var(--radius-md, 8px);
  background: rgba(0, 0, 0, 0.55);
  backdrop-filter: blur(12px);
  -webkit-backdrop-filter: blur(12px);
  border: 1px solid rgba(255, 255, 255, 0.08);
  font-size: 14px;
  font-weight: 500;
  color: rgba(255, 255, 255, 0.9);
  z-index: 18;
  pointer-events: none;
}
.cvp__seek-indicator--back { left: 20%; }
.cvp__seek-indicator--fwd { right: 20%; }

/* ─── 底部控制栏 ─── */
.cvp__controls {
  position: absolute;
  bottom: 0;
  left: 0;
  right: 0;
  padding: 0 14px 12px;
  background: linear-gradient(
    to top,
    rgba(0, 0, 0, 0.72) 0%,
    rgba(0, 0, 0, 0.35) 60%,
    transparent 100%
  );
  z-index: 20;
  opacity: 0;
  transform: translateY(4px);
  transition: opacity 0.25s cubic-bezier(0.16, 1, 0.3, 1),
              transform 0.25s cubic-bezier(0.16, 1, 0.3, 1);
  pointer-events: none;
}
.cvp--controls-visible .cvp__controls {
  opacity: 1;
  transform: translateY(0);
  pointer-events: auto;
}

/* ─── 进度条 ─── */
.cvp__progress {
  position: relative;
  width: 100%;
  height: 4px;
  touch-action: none;
  margin-bottom: 8px;
  cursor: pointer;
  border-radius: 999px;
  transition: height 0.15s ease;
}
.cvp__progress:hover,
.cvp__progress--dragging {
  height: 6px;
}
.cvp__progress-track {
  position: absolute;
  inset: 0;
  background: rgba(255, 255, 255, 0.15);
  border-radius: 999px;
  overflow: hidden;
}
.cvp__progress-buffered {
  position: absolute;
  top: 0;
  left: 0;
  bottom: 0;
  background: rgba(255, 255, 255, 0.25);
  border-radius: 999px;
  transition: width 0.3s linear;
}
.cvp__progress-played {
  position: absolute;
  top: 0;
  left: 0;
  bottom: 0;
  background: var(--seed-primary, #0972D3);
  border-radius: 999px;
}
.cvp__progress-thumb {
  position: absolute;
  top: 50%;
  width: 14px;
  height: 14px;
  border-radius: 50%;
  background: var(--seed-primary, #0972D3);
  box-shadow: 0 0 0 3px rgba(255, 255, 255, 0.2), 0 2px 6px rgba(0, 0, 0, 0.35);
  transform: translate(-50%, -50%) scale(0);
  transition: transform 0.15s cubic-bezier(0.16, 1, 0.3, 1);
  z-index: 2;
}
.cvp__progress:hover .cvp__progress-thumb,
.cvp__progress--dragging .cvp__progress-thumb {
  transform: translate(-50%, -50%) scale(1);
}
.cvp__progress-tooltip {
  position: absolute;
  bottom: calc(100% + 8px);
  transform: translateX(-50%);
  padding: 3px 7px;
  border-radius: var(--radius-sm, 4px);
  background: rgba(0, 0, 0, 0.75);
  backdrop-filter: blur(8px);
  -webkit-backdrop-filter: blur(8px);
  border: 1px solid rgba(255, 255, 255, 0.1);
  font-family: ui-monospace, SF Mono, Menlo, monospace;
  font-size: 12px;
  font-weight: 500;
  color: rgba(255, 255, 255, 0.9);
  white-space: nowrap;
  pointer-events: none;
  z-index: 5;
}

/* ─── 按钮行 ─── */
.cvp__btn-row {
  display: flex;
  align-items: center;
  gap: 2px;
}
.cvp__btn {
  width: 36px;
  height: 36px;
  border: none;
  border-radius: var(--radius-md, 8px);
  background: transparent;
  color: rgba(255, 255, 255, 0.85);
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: background 0.12s ease, color 0.12s ease, transform 0.1s ease;
  flex-shrink: 0;
  padding: 0;
}
.cvp__btn:hover {
  background: rgba(255, 255, 255, 0.1);
  color: #fff;
}
.cvp__btn:active {
  transform: scale(0.9);
}
.cvp__btn--play {
  width: 40px;
  height: 40px;
}
.cvp__btn--speed,
.cvp__btn--end-behavior {
  width: auto;
  padding: 0 8px;
  font-family: inherit;
  font-size: 12px;
  font-weight: 600;
  letter-spacing: 0.02em;
  color: rgba(255, 255, 255, 0.7);
}
.cvp__btn--end-behavior {
  gap: 4px;
  min-width: 62px;
}
.cvp__btn--speed:hover,
.cvp__btn--end-behavior:hover {
  color: #fff;
}

/* ─── 时间 ─── */
.cvp__time {
  font-family: ui-monospace, SF Mono, Menlo, monospace;
  font-size: 12px;
  font-weight: 500;
  color: rgba(255, 255, 255, 0.6);
  white-space: nowrap;
  padding: 0 4px;
  min-width: 88px;
}
.cvp__time-current {
  color: rgba(255, 255, 255, 0.9);
}
.cvp__time-sep {
  color: rgba(255, 255, 255, 0.3);
}
.cvp__spacer { flex: 1; }

/* ─── 音量 ─── */
.cvp__volume {
  display: flex;
  align-items: center;
  position: relative;
}
.cvp__volume-slider-wrap {
  width: 0;
  overflow: hidden;
  transition: width 0.2s cubic-bezier(0.16, 1, 0.3, 1);
}
.cvp__volume:hover .cvp__volume-slider-wrap {
  width: 72px;
}
.cvp__volume-slider {
  -webkit-appearance: none;
  appearance: none;
  width: 64px;
  height: 4px;
  border-radius: 2px;
  background: rgba(255, 255, 255, 0.15);
  outline: none;
  margin: 0 4px;
  cursor: pointer;
}
.cvp__volume-slider::-webkit-slider-thumb {
  -webkit-appearance: none;
  width: 12px;
  height: 12px;
  border-radius: 50%;
  background: #fff;
  cursor: pointer;
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.3);
}
.cvp__volume-slider::-moz-range-thumb {
  width: 12px;
  height: 12px;
  border-radius: 50%;
  background: #fff;
  border: none;
  cursor: pointer;
}

/* ─── 播放行为 / 速度菜单 ─── */
.cvp__speed-wrap,
.cvp__end-behavior-wrap {
  position: relative;
}
.cvp__speed-menu,
.cvp__end-behavior-menu {
  position: absolute;
  bottom: calc(100% + 6px);
  right: 0;
  min-width: 96px;
  padding: 4px 0;
  background: rgba(20, 22, 28, 0.88);
  backdrop-filter: blur(20px);
  -webkit-backdrop-filter: blur(20px);
  border: 1px solid rgba(255, 255, 255, 0.1);
  border-radius: var(--radius-md, 8px);
  box-shadow: 0 8px 32px rgba(0, 0, 0, 0.4);
  z-index: 30;
  transform-origin: bottom right;
}
.cvp__end-behavior-menu {
  min-width: 148px;
}
.cvp__speed-item,
.cvp__end-behavior-item {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 100%;
  padding: 6px 14px;
  border: 0;
  background: transparent;
  font-family: inherit;
  font-size: 13px;
  font-weight: 500;
  color: rgba(255, 255, 255, 0.65);
  cursor: pointer;
  transition: background 0.1s ease, color 0.1s ease;
  text-align: center;
}
.cvp__end-behavior-item {
  justify-content: space-between;
  gap: 12px;
  text-align: left;
}
.cvp__speed-item:hover,
.cvp__end-behavior-item:hover {
  background: rgba(255, 255, 255, 0.08);
  color: rgba(255, 255, 255, 0.95);
}
.cvp__speed-item--active,
.cvp__end-behavior-item--active {
  color: var(--seed-primary, #0972D3);
  font-weight: 600;
}

/* ─── 窄屏适配 ─── */
@media (max-width: 480px) {
  .cvp__btn--end-behavior { min-width: 36px; padding: 0; }
  .cvp__btn--end-behavior span { display: none; }
  .cvp__time { min-width: 76px; font-size: 11px; }
  .cvp__btn { width: 32px; height: 32px; }
  .cvp__btn--play { width: 36px; height: 36px; }
  .cvp__volume-slider-wrap { display: none; }
}

/* ─── 过渡 ─── */
.cvp-fade-enter-active,
.cvp-fade-leave-active {
  transition: opacity 0.2s ease;
}
.cvp-fade-enter-from,
.cvp-fade-leave-to {
  opacity: 0;
}
</style>
