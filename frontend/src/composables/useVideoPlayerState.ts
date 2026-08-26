/**
 * 视频播放器状态 composable（CustomVideoPlayer 专用）
 *
 * 职责：
 * - 播放 / 进度 / 指示器 / 全屏状态 refs。
 * - 音量与倍速 localStorage 持久化偏好。
 * - 媒体元数据可用后一次性恢复播放进度。
 * - 时间格式化工具。
 *
 * 依赖注入（保持与 UI 解耦）：
 * - getVideoRef：访问宿主 <video> 元素。
 * - getInitialTime：当前媒体待恢复进度（秒），仅应用一次。
 */
import { ref } from 'vue';

export interface VideoPlayerStateOptions {
  getInitialTime: () => number;
}

export function useVideoPlayerState(options: VideoPlayerStateOptions) {
  const { getInitialTime } = options;

  // ─── 持久化偏好 ────────────────────────────
  const VIDEO_VOLUME_KEY = 'file-preview-video-volume';
  const VIDEO_RATE_KEY = 'file-preview-video-rate';
  const DEFAULT_VIDEO_VOLUME = 0.5;

  function loadSavedVolume(): number {
    try {
      const raw = localStorage.getItem(VIDEO_VOLUME_KEY);
      // 无存储值时 Number(null) === 0，会被当作合法音量跳过默认值，导致新用户首播静音
      if (raw == null) return DEFAULT_VIDEO_VOLUME;
      const saved = Number(raw);
      if (Number.isFinite(saved) && saved >= 0 && saved <= 1) return saved;
    } catch { /* 隐私模式或存储被禁用时使用默认音量 */ }
    return DEFAULT_VIDEO_VOLUME;
  }

  function saveVolume(value: number) {
    try { localStorage.setItem(VIDEO_VOLUME_KEY, String(value)); } catch { /* 不影响播放 */ }
  }

  function loadSavedRate(): number {
    try {
      const saved = Number(localStorage.getItem(VIDEO_RATE_KEY));
      if (Number.isFinite(saved) && saved >= 0.5 && saved <= 3) return saved;
    } catch { /* 存储不可用时使用默认倍速 */ }
    return 1;
  }

  function saveRate(value: number) {
    try { localStorage.setItem(VIDEO_RATE_KEY, String(value)); } catch { /* 不影响播放 */ }
  }

  // ─── 播放状态 ────────────────────────────
  const isPaused = ref(true);
  const isEnded = ref(false);
  const isBuffering = ref(false);
  const currentTime = ref(0);
  const duration = ref(0);
  const volume = ref(loadSavedVolume());
  const isMuted = ref(false);
  const currentSpeed = ref(loadSavedRate());
  const controlsVisible = ref(true);
  const speedMenuOpen = ref(false);
  const endBehaviorMenuOpen = ref(false);
  const volumeHover = ref(false);

  // Progress bar
  const playedPct = ref(0);
  const bufferedPct = ref(0);
  const isDragging = ref(false);
  const dragPct = ref<number | null>(null);
  const tooltipVisible = ref(false);
  const tooltipLeft = ref(0);
  const tooltipTime = ref('0:00');

  // Indicators
  const speedIndicatorVisible = ref(false);
  const speedIndicatorText = ref('');
  const seekIndicator = ref<{ dir: 'back' | 'fwd'; text: string } | null>(null);

  // Fullscreen
  const isFullscreen = ref(false);

  // ─── 恢复进度 ────────────────────────────
  /** 当前 src 的恢复点是否已应用（src 变化后重置，仅应用一次） */
  let initialTimeConsumed = false;

  function applyInitialTime(v: HTMLVideoElement) {
    if (initialTimeConsumed) return;
    const target = getInitialTime();
    if (!target || target <= 0) return;
    if (!Number.isFinite(v.duration) || v.duration <= 0) return;
    const t = Math.min(target, Math.max(0, v.duration - 1));
    if (t <= 0) return;
    // duration 校验通过后才标记已应用，避免元数据尚不可用时吞掉恢复点
    initialTimeConsumed = true;
    v.currentTime = t;
    currentTime.value = t;
    playedPct.value = (t / v.duration) * 100;
  }

  /** src 变化后重置「恢复点已应用」标记，允许新媒体重新恢复 */
  function resetInitialTime() {
    initialTimeConsumed = false;
  }

  function onFullscreenChange() {
    isFullscreen.value = !!document.fullscreenElement;
  }

  // ─── 工具函数 ────────────────────────────
  function formatTime(s: number): string {
    if (!isFinite(s) || s < 0) return '0:00';
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = Math.floor(s % 60);
    if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
    return `${m}:${String(sec).padStart(2, '0')}`;
  }

  return {
    // 播放状态
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
    // 进度条
    playedPct,
    bufferedPct,
    isDragging,
    dragPct,
    tooltipVisible,
    tooltipLeft,
    tooltipTime,
    // 指示器
    speedIndicatorVisible,
    speedIndicatorText,
    seekIndicator,
    // 全屏
    isFullscreen,
    // 持久化
    DEFAULT_VIDEO_VOLUME,
    saveVolume,
    saveRate,
    // 工具 / 状态机
    applyInitialTime,
    resetInitialTime,
    onFullscreenChange,
    formatTime,
  };
}
