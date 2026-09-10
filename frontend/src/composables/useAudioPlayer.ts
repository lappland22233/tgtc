/**
 * 自定义音频播放器（隐藏原生控件 + 自绘播放/进度/音量/倍速 + 实时波形）。
 *
 * M6 拆分专项：从 FilePreviewDialog.vue 下沉为 composable（与既有
 * usePreviewPoster / usePreviewText / usePlaylistControls / useImageViewer 同一模式），
 * 使宿主只保留「媒体源准备 / 模板绑定 / 键盘快捷键转发」三类职责。
 *
 * 行为与拆分前完全一致，包括：
 * - 隐藏的 `<audio class="fpv-audio-core">` 仅作媒体内核，所有可见交互由本模块驱动；
 * - 进度条拖动全程只改草稿（previewSeek），松手才 write 一次 currentTime；
 * - Web Audio 波形挂载在媒体元素上，播放时启动 rAF、暂停/收起/卸载时停止；
 * - 元数据就绪后应用 store 的恢复点（仅当目标位置可 seek 时写入，避免冷资源重复请求）；
 * - 倍速仅属于当前预览会话，新媒体加载时强制回到 1×。
 */
import { computed, ref } from 'vue';
import type { Ref } from 'vue';
import type { useMediaPlaybackStore } from '../stores/mediaPlayback';

/** 倍速档位（与 CustomVideoPlayer 档位保持一致） */
const AUDIO_RATES = [0.5, 0.75, 1, 1.25, 1.5, 2, 3] as const;

const AUDIO_WAVE_BAR_COUNT = 28;
const AUDIO_WAVE_REFRESH_INTERVAL = 1000 / 45;
/** 波形默认高度（百分比） */
const AUDIO_WAVE_IDLE_HEIGHT = 28;

export interface AudioPlayerOptions {
  mediaStore: ReturnType<typeof useMediaPlaybackStore>;
  /** 隐藏的音频内核元素（宿主持有，模板 ref 与 resetState 共用同一引用） */
  audioEl: Ref<HTMLAudioElement | null>;
  /** 播放自然结束后的续播处理（宿主来自 usePlaylistControls） */
  onEnded: () => void;
  /** 节流持久化播放进度（宿主与视频路径共用同一节流器） */
  persistProgress: () => void;
}

export function useAudioPlayer(options: AudioPlayerOptions) {
  const { mediaStore, audioEl: audioRef, onEnded, persistProgress } = options;

  // ============ 自定义音频控制 ============
  /** 音频当前播放位置（由 timeupdate 驱动，供自定义进度条渲染） */
  const audioCurrentTime = ref(0);
  /** 音频总时长（loadedmetadata 后可用） */
  const audioDuration = ref(0);
  /** 音量（0-1，跟随 audio.volume；静音时归零显示） */
  const audioVolume = ref(0.5);
  /** 静音状态（跟随 audio.muted） */
  const audioMuted = ref(false);
  const audioRate = ref(1);
  /** 音量输入框 v-model 绑定的中间值（避免拖动时被事件回写干扰） */
  const audioVolumeInput = ref(0.5);
  /** 进度条拖动中：只更新草稿，不触碰媒体 currentTime */
  const audioSeeking = ref(false);
  const audioSeekDraft = ref<number | null>(null);
  const audioDisplayTime = computed(() => audioSeekDraft.value ?? audioCurrentTime.value);

  /** 播放进度百分比（0-100） */
  const audioProgressPct = computed(() => {
    const time = audioDisplayTime.value;
    if (audioDuration.value <= 0 || !Number.isFinite(time)) return 0;
    return Math.min(100, Math.max(0, (time / audioDuration.value) * 100));
  });

  /** 时间格式化：mm:ss / h:mm:ss */
  function formatAudioTime(s: number): string {
    if (!Number.isFinite(s) || s < 0) return '0:00';
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = Math.floor(s % 60);
    if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
    return `${m}:${String(sec).padStart(2, '0')}`;
  }

  /** 播放 / 暂停切换（与桥接语义一致） */
  function toggleAudioPlay() {
    const a = audioRef.value;
    if (!a) return;
    if (a.paused) void a.play().catch(() => {});
    else a.pause();
  }

  /** 相对跳转 */
  function seekAudioBy(seconds: number) {
    const a = audioRef.value;
    if (!a) return;
    a.currentTime = Math.max(0, Math.min(a.duration || 0, a.currentTime + seconds));
  }

  /** 点击进度条跳转（直接点击不启用拖动状态） */
  /** 从指针坐标计算进度比例（0-1） */
  function audioProgressRatioFromClientX(clientX: number, progressEl?: HTMLElement): number {
    const track = progressEl?.querySelector<HTMLElement>('.fpv-audio-progress-track')
      ?? document.querySelector<HTMLElement>('.fpv-audio-progress-track');
    if (!track) return 0;
    const rect = track.getBoundingClientRect();
    if (rect.width <= 0) return 0;
    return Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
  }

  /** 按下进度条开始拖动：Pointer Events 统一鼠标与触屏，setPointerCapture 保证拖动不脱手 */
  function ensureAudioDuration(): HTMLAudioElement | null {
    const audio = document.querySelector<HTMLAudioElement>('.fpv-audio-core') ?? audioRef.value;
    if (audioDuration.value <= 0 && audio && Number.isFinite(audio.duration) && audio.duration > 0) {
      audioDuration.value = audio.duration;
    }
    if (audio) audioRef.value = audio;
    return audio;
  }

  function onAudioProgressDown(e: PointerEvent) {
    const audio = ensureAudioDuration();
    const el = e.currentTarget as HTMLElement;
    audioRef.value ||= audio;
    audioSeeking.value = true;
    audioSeekDraft.value = audioProgressRatioFromClientX(e.clientX, el) * audioDuration.value;
    el.setPointerCapture?.(e.pointerId);
    previewAudioSeek(e.clientX);
  }

  /** 拖动中更新位置（仅当指针被捕获到进度条上） */
  function onAudioProgressMove(e: PointerEvent) {
    if (!audioSeeking.value) return;
    ensureAudioDuration();
    // Pointer capture is an enhancement; jsdom and some browsers may deliver the event without it.
    previewAudioSeek(e.clientX, e.currentTarget as HTMLElement);
  }

  /** 拖动结束：释放捕获并复位状态 */
  function onAudioProgressUp(e: PointerEvent) {
    if (!audioSeeking.value) return;
    const el = e.currentTarget as HTMLElement;
    if (audioSeekDraft.value == null) previewAudioSeek(e.clientX);
    if (audioSeekDraft.value != null) commitAudioSeek(audioSeekDraft.value);
    audioSeekDraft.value = null;
    audioSeeking.value = false;
    if (el.hasPointerCapture?.(e.pointerId)) {
      try { el.releasePointerCapture(e.pointerId); } catch { /* 已释放则忽略 */ }
    }
  }

  function onAudioProgressCancel(e: PointerEvent) {
    if (!audioSeeking.value) return;
    const el = e.currentTarget as HTMLElement;
    audioSeekDraft.value = null;
    audioSeeking.value = false;
    if (el.hasPointerCapture?.(e.pointerId)) {
      try { el.releasePointerCapture(e.pointerId); } catch { /* 已释放则忽略 */ }
    }
  }

  /** 拖动预览：只更新 UI 草稿，不写入媒体 currentTime */
  function previewAudioSeek(clientX: number, progressEl?: HTMLElement) {
    const audio = ensureAudioDuration();
    const duration = audioDuration.value > 0 ? audioDuration.value : audio?.duration ?? 0;
    if (duration <= 0) return;
    audioSeekDraft.value = audioProgressRatioFromClientX(clientX, progressEl) * duration;
  }

  /** 拖动结束时仅执行一次真实 seek */
  function commitAudioSeek(target: number) {
    const a = audioRef.value;
    if (!a || audioDuration.value <= 0) return;
    a.currentTime = Math.max(0, Math.min(audioDuration.value, target));
  }

  /** 静音切换 */
  function toggleAudioMute() {
    const a = audioRef.value;
    if (!a) return;
    a.muted = !a.muted;
  }

  /** 音量滑块输入（输入框值 → audio.volume） */
  function onAudioVolumeInput() {
    const a = audioRef.value;
    if (!a) return;
    a.volume = audioVolumeInput.value;
    if (a.volume > 0 && a.muted) a.muted = false;
    audioVolume.value = a.volume;
    audioMuted.value = a.muted;
  }

  /** audio.volumechange 同步状态（迷你播放器 / 外部修改时保持同步） */
  function onAudioVolumeChange() {
    const a = audioRef.value;
    if (!a) return;
    audioVolume.value = a.volume;
    audioMuted.value = a.muted;
    audioVolumeInput.value = a.volume;
  }

  /** 循环切换倍速档位 */
  function cycleAudioRate() {
    const idx = AUDIO_RATES.indexOf(audioRate.value as (typeof AUDIO_RATES)[number]);
    audioRate.value = AUDIO_RATES[(idx + 1) % AUDIO_RATES.length];
    const a = audioRef.value;
    if (a) a.playbackRate = audioRate.value;
  }

  // ============ 音频波形 ============
  /** 音频是否正在播放（驱动波形装饰动画） */
  const audioPlaying = ref(false);
  const audioWaveBars = ref(Array.from({ length: AUDIO_WAVE_BAR_COUNT }, () => ({ height: AUDIO_WAVE_IDLE_HEIGHT })));
  let audioContext: AudioContext | null = null;
  let audioAnalyser: AnalyserNode | null = null;
  let audioSource: MediaElementAudioSourceNode | null = null;
  let audioWaveFrame = 0;
  let audioWaveLastUpdate = 0;
  let audioWaveData: Uint8Array | null = null;

  function stopAudioWaveform() {
    if (audioWaveFrame) cancelAnimationFrame(audioWaveFrame);
    audioWaveFrame = 0;
    audioWaveLastUpdate = 0;
    audioSource?.disconnect();
    audioAnalyser?.disconnect();
    audioSource = null;
    audioAnalyser = null;
    audioWaveData = null;
    if (audioContext) void audioContext.close().catch(() => {});
    audioContext = null;
    audioWaveBars.value = Array.from({ length: AUDIO_WAVE_BAR_COUNT }, () => ({ height: AUDIO_WAVE_IDLE_HEIGHT }));
  }

  function updateAudioWaveform(timestamp: number) {
    if (!audioPlaying.value || !audioAnalyser || !audioWaveData) return;
    if (timestamp - audioWaveLastUpdate < AUDIO_WAVE_REFRESH_INTERVAL) {
      audioWaveFrame = requestAnimationFrame(updateAudioWaveform);
      return;
    }
    audioWaveLastUpdate = timestamp;
    audioAnalyser.getByteTimeDomainData(audioWaveData as any);
    const bucketSize = Math.max(1, Math.floor(audioWaveData.length / AUDIO_WAVE_BAR_COUNT));
    audioWaveBars.value = Array.from({ length: AUDIO_WAVE_BAR_COUNT }, (_, index) => {
      const start = index * bucketSize;
      const end = Math.min(audioWaveData!.length, start + bucketSize);
      let peak = 0;
      for (let i = start; i < end; i++) peak = Math.max(peak, Math.abs(audioWaveData![i] - 128));
      return { height: Math.min(100, Math.max(AUDIO_WAVE_IDLE_HEIGHT, AUDIO_WAVE_IDLE_HEIGHT + peak * 2.4)) };
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

  /** 恢复波形动画循环（收起后重新展开时调用） */
  function resumeAudioWaveformLoop() {
    if (audioPlaying.value && !audioWaveFrame) {
      audioWaveFrame = requestAnimationFrame(updateAudioWaveform);
    }
  }

  /** 暂停波形动画循环（收起为迷你播放器时调用，音频不停止） */
  function pauseAudioWaveformLoop() {
    if (audioWaveFrame) cancelAnimationFrame(audioWaveFrame);
    audioWaveFrame = 0;
    audioWaveLastUpdate = 0;
  }

  function onAudioPlay() {
    audioPlaying.value = true;
    mediaStore.setPlayState('playing');
    setupAudioWaveform();
    if (audioContext?.state === 'suspended') void audioContext.resume();
    if (!audioWaveFrame) audioWaveFrame = requestAnimationFrame(updateAudioWaveform);
  }

  function onAudioPause() {
    audioPlaying.value = false;
    mediaStore.setPlayState('paused');
    if (audioWaveFrame) cancelAnimationFrame(audioWaveFrame);
    audioWaveFrame = 0;
    audioWaveLastUpdate = 0;
    mediaStore.persistProgress();
  }

  function onAudioEnded() {
    onAudioPause();
    onEnded();
  }

  /** 音频进度同步（驱动自定义进度条）+ 节流持久化 */
  function onAudioTimeUpdate(e: Event) {
    const a = (e.currentTarget as HTMLAudioElement | null)
      || (e.target as HTMLAudioElement | null)
      || audioRef.value
      || document.querySelector<HTMLAudioElement>('.fpv-audio-core');
    if (!a) return;
    audioRef.value ||= a;
    audioCurrentTime.value = a.currentTime;
    if (Number.isFinite(a.duration) && a.duration > 0) audioDuration.value = a.duration;
    mediaStore.setProgress(a.currentTime, a.duration);
    persistProgress();
  }

  /** 音频元数据可用后应用恢复点（恢复点已在 store 层完成版本校验） */
  function onAudioLoadedMeta(e: Event) {
    const a = (e.currentTarget as HTMLAudioElement | null)
      || (e.target as HTMLAudioElement | null)
      || audioRef.value;
    const resume = mediaStore.pendingResume;
    if (!a) return;
    // 同步时长与音量/倍速偏好（倍速恢复与视频保持一致）
    if (Number.isFinite(a.duration) && a.duration > 0) audioDuration.value = a.duration;
    audioVolume.value = a.volume;
    audioMuted.value = a.muted;
    audioVolumeInput.value = a.volume;
    // 倍速仅属于当前预览会话；新媒体元数据就绪时强制应用 1×。
    audioRate.value = 1;
    a.playbackRate = 1;
    if (!resume || resume <= 0) return;
    if (!Number.isFinite(a.duration) || a.duration <= 0) return;
    const t = Math.min(resume, Math.max(0, a.duration - 1));
    // 仅当目标位置可定位时才设置 currentTime，避免冷资源下在未缓冲位置触发重复请求
    const seekable = a.seekable;
    let canSeek = false;
    for (let i = 0; i < seekable.length; i++) {
      if (t >= seekable.start(i) && t <= seekable.end(i)) { canSeek = true; break; }
    }
    if (canSeek || seekable.length === 0) a.currentTime = t;
  }

  /** 停掉波形并卸载音频内核载荷（保留元素本身，供下次复用） */
  function stopAudioPlayback() {
    stopAudioWaveform();
    const audio = audioRef.value;
    if (audio) {
      audio.pause();
      audio.removeAttribute('src');
      audio.load();
    }
    audioPlaying.value = false;
  }

  /** 切换文件 / 清空会话时的完整复位 */
  function resetAudioState() {
    stopAudioPlayback();
    audioCurrentTime.value = 0;
    audioDuration.value = 0;
    audioSeeking.value = false;
    audioSeekDraft.value = null;
  }

  /** 组件卸载：仅停掉波形与播放标记（与拆分前 onBeforeUnmount 行为一致） */
  function disposeAudioPlayer() {
    stopAudioWaveform();
    audioPlaying.value = false;
  }

  return {
    audioDisplayTime,
    audioProgressPct,
    formatAudioTime,
    audioPlaying,
    audioWaveBars,
    audioMuted,
    audioVolume,
    audioVolumeInput,
    audioRate,
    audioDuration,
    audioSeeking,
    toggleAudioPlay,
    seekAudioBy,
    onAudioProgressDown,
    onAudioProgressMove,
    onAudioProgressUp,
    onAudioProgressCancel,
    toggleAudioMute,
    onAudioVolumeInput,
    cycleAudioRate,
    onAudioPlay,
    onAudioPause,
    onAudioEnded,
    onAudioTimeUpdate,
    onAudioLoadedMeta,
    onAudioVolumeChange,
    resumeAudioWaveformLoop,
    pauseAudioWaveformLoop,
    stopAudioPlayback,
    resetAudioState,
    disposeAudioPlayer,
  };
}
