/**
 * 视频播放器状态 composable（CustomVideoPlayer 专用）
 *
 * 职责：
 * - 播放 / 进度 / 指示器 / 全屏状态 refs。
 * - 音量与倍速 localStorage 持久化偏好。
 * - 冷资源延迟恢复（deferred resume）状态机：initialTime 仅在缓冲覆盖后执行一次 seek，
 *   避免在未缓冲位置设置 currentTime 触发浏览器发起不可满足的 Range/全量请求。
 * - 缓冲边界 / seek 钳制 / 时间格式化工具。
 *
 * 依赖注入（保持与 UI 解耦）：
 * - getVideoRef：访问宿主 <video> 元素。
 * - getCold：是否处于冷资源加载模式（钳制 seek 的开关）。
 * - getInitialTime：当前媒体待恢复进度（秒），仅应用一次。
 */
import { ref } from 'vue';

export interface VideoPlayerStateOptions {
  getVideoRef: () => HTMLVideoElement | null;
  getCold: () => boolean;
  getInitialTime: () => number;
}

export function useVideoPlayerState(options: VideoPlayerStateOptions) {
  const { getVideoRef, getCold, getInitialTime } = options;

  // ─── 持久化偏好 ────────────────────────────
  const VIDEO_VOLUME_KEY = 'file-preview-video-volume';
  const VIDEO_RATE_KEY = 'file-preview-video-rate';
  const DEFAULT_VIDEO_VOLUME = 0.5;

  function loadSavedVolume(): number {
    try {
      const saved = Number(localStorage.getItem(VIDEO_VOLUME_KEY));
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

  // ─── 冷资源延迟恢复状态 ────────────────────────────
  /** 当前 src 的恢复点是否已应用（src 变化后重置，仅应用一次） */
  let initialTimeConsumed = false;
  /** 冷资源下待延迟恢复的位置（秒）；buffered 覆盖后执行一次 seek */
  let deferredResumeTarget = 0;
  /** 冷资源延迟恢复等待起始时间（用于超时放弃） */
  let deferredResumeStart = 0;
  /** 冷资源延迟恢复超时轮询定时器 */
  let resumePollTimer: ReturnType<typeof setInterval> | null = null;
  /** 冷资源延迟恢复等待超时（毫秒）：超时后放弃恢复，继续从头播放，不阻断体验 */
  const RESUME_WAIT_TIMEOUT_MS = 30000;

  /** 当前最大已缓冲 end；无缓冲返回 0 */
  function getMaxBufferedEnd(): number {
    const v = getVideoRef();
    if (!v || !v.buffered.length) return 0;
    let maxEnd = 0;
    for (let i = 0; i < v.buffered.length; i++) {
      if (v.buffered.end(i) > maxEnd) maxEnd = v.buffered.end(i);
    }
    return maxEnd;
  }

  /** 冷资源加载阶段把目标时间钳制到已缓冲末尾以内，防止浏览器发起越界 Range 请求 */
  function clampSeekTarget(target: number): number {
    if (!getCold()) return target;
    const maxEnd = getMaxBufferedEnd();
    if (maxEnd <= 0) return 0;
    // 留 0.1s 余量，避免 seek 恰好落在缓冲末尾边界触发新的分段请求
    return Math.min(target, Math.max(0, maxEnd - 0.1));
  }

  function clearDeferredResumeTimer() {
    if (resumePollTimer) {
      clearInterval(resumePollTimer);
      resumePollTimer = null;
    }
  }

  function cancelDeferredResume() {
    clearDeferredResumeTimer();
    deferredResumeTarget = 0;
    deferredResumeStart = 0;
  }

  /**
   * 冷资源延迟恢复：仅当 buffered 已覆盖恢复点时才执行一次 seek，
   * 避免在未缓冲位置设置 currentTime 触发浏览器发起不可满足的 Range/全量请求。
   */
  function tryDeferredResume() {
    if (deferredResumeTarget <= 0) return;
    const v = getVideoRef();
    if (!v) return;
    if (getMaxBufferedEnd() < deferredResumeTarget) return;
    const target = clampSeekTarget(deferredResumeTarget);
    v.currentTime = target;
    currentTime.value = target;
    playedPct.value = duration.value > 0 ? (target / duration.value) * 100 : 0;
    deferredResumeTarget = 0;
    clearDeferredResumeTimer();
  }

  /** 冷资源恢复点等待：轮询超时后放弃（不阻断播放）；实际 seek 由缓冲覆盖后的 tryDeferredResume 触发 */
  function scheduleDeferredResume(target: number) {
    deferredResumeTarget = target;
    deferredResumeStart = Date.now();
    clearDeferredResumeTimer();
    resumePollTimer = setInterval(() => {
      if (deferredResumeTarget <= 0) {
        clearDeferredResumeTimer();
        return;
      }
      if (Date.now() - deferredResumeStart > RESUME_WAIT_TIMEOUT_MS) {
        // 等待超时：放弃恢复到该位置，继续从头播放
        deferredResumeTarget = 0;
        clearDeferredResumeTimer();
      }
    }, 1000);
  }

  function applyInitialTime(v: HTMLVideoElement) {
    if (initialTimeConsumed) return;
    const target = getInitialTime();
    if (!target || target <= 0) return;
    if (!Number.isFinite(v.duration) || v.duration <= 0) return;
    const t = Math.min(target, Math.max(0, v.duration - 1));
    if (t <= 0) return;
    // duration 校验通过后才标记已应用，避免元数据尚不可用时吞掉恢复点
    initialTimeConsumed = true;
    // 热缓存：可直接恢复（后端可提供真实 206 Range，seek 高效）
    if (!getCold()) {
      v.currentTime = t;
      currentTime.value = t;
      return;
    }
    // 冷资源：恢复点已在缓冲范围内则立即恢复；
    // 否则记录待恢复位置从头播放，等缓冲覆盖后再 seek，避免制造第二个媒体请求。
    const maxEnd = getMaxBufferedEnd();
    if (maxEnd >= t) {
      v.currentTime = clampSeekTarget(t);
      currentTime.value = v.currentTime;
    } else {
      scheduleDeferredResume(t);
    }
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
    getMaxBufferedEnd,
    clampSeekTarget,
    cancelDeferredResume,
    applyInitialTime,
    resetInitialTime,
    tryDeferredResume,
    onFullscreenChange,
    formatTime,
  };
}
