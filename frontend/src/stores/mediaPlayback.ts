/**
 * 全局媒体播放会话 Store
 *
 * 职责：
 * - 持有「当前媒体 + 来源上下文 + 播放列表」的唯一会话（不随路由卸载）。
 * - 通过桥接层（MediaPlayerBridge）控制实际挂在 FilePreviewDialog 内的媒体实例，
 *   供 MiniMediaPlayer 等路由之外的 UI 复用同一 <audio>/<video>，切换导航不中断。
 * - 本地播放进度持久化（localStorage，按来源上下文 + 文件隔离），
 *   支持恢复点校验（无效 / 过期 / 接近结尾不恢复）。
 * - 记录播放状态与上传浮层可见性（迷你播放器据此左右避让）。
 *
 * 安全约定：
 * - 分享访问 JWT 仅保存在内存会话中，绝不写入 localStorage。
 * - 进度键只使用分享 token（分享链接公开标识），不含凭据。
 */
import { computed, ref } from 'vue';
import { defineStore } from 'pinia';

/** 预览类别；只有 video / audio 支持持续播放会话 */
export type MediaKind = 'image' | 'video' | 'audio' | 'pdf' | 'text';

export interface MediaSessionItem {
  id: string;
  name: string;
  mimeType: string;
  kind: MediaKind;
  size?: number;
  /** 同源 inline 预览地址 */
  src: string;
  /** 下载地址；未传时用 src 兜底 */
  downloadUrl?: string;
  /**
   * 媒体内容版本指纹（映射后端 File.uploadVersion，覆盖上传时递增）。
   * 进度记录会绑定该版本；文件被覆盖后旧记录自动失效，避免旧内容进度错误应用到新内容。
   */
  contentVersion?: string | number;
}

export type MediaSourceContext =
  | { type: 'user'; userId?: string }
  | { type: 'share'; token: string; accessJwt?: string };

export interface MediaSession {
  context: MediaSourceContext;
  item: MediaSessionItem;
  playlist: MediaSessionItem[];
  playlistIndex: number;
}

export type MediaPlayState = 'playing' | 'paused' | 'buffering' | 'ended';

/**
 * 由 FilePreviewDialog 注册的播放控制桥。
 * 迷你播放器等 UI 通过 store 转发到桥，控制同一媒体实例。
 */
export interface MediaPlayerBridge {
  play(): void;
  pause(): void;
  togglePlay(): void;
  seekTo(time: number): void;
  seekBy(seconds: number): void;
  next(): void;
  prev(): void;
  /** 真正停止：暂停、清空 src、释放资源并清空会话 */
  stop(): void;
}

// ─── 本地进度持久化 ─────────────────────────────────────
const PROGRESS_PREFIX = 'fc:media-progress:v1:';
const PROGRESS_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 天
const RESUME_MIN_SEC = 10; // 小于 10 秒的进度无恢复意义
const RESUME_TAIL_SEC = 15; // 距结尾不足 15 秒不恢复（避免每次重看结尾）

export function buildProgressKey(context: MediaSourceContext, fileId: string): string {
  const ctxKey = context.type === 'share'
    ? `s:${context.token}`
    : `u:${context.userId ?? ''}`;
  return `${PROGRESS_PREFIX}${ctxKey}:${fileId}`;
}

/** 持久化进度记录结构（v 为内容版本，缺失表示旧格式记录） */
interface ResumeRecord {
  t: number;
  d: number;
  ts: number;
  v?: string | number;
}

/**
 * 纯函数：读取并校验本地保存的进度点；无效 / 过期 / 接近结尾 / 版本不匹配返回 0（从头播放）。
 *
 * 版本语义（覆盖上传保留同一 fileId 时用于防止旧进度错配新内容）：
 * - 记录带 v 且调用方提供 contentVersion：v 与 contentVersion 不一致 → 记录失效并清除。
 * - 记录无 v（旧格式）且调用方提供 contentVersion：无法确认内容是否被覆盖 → 一次性失效并清除。
 * - 调用方未提供 contentVersion：跳过版本校验（向后兼容旧调用路径）。
 */
export function readResumePoint(
  context: MediaSourceContext,
  fileId: string,
  contentVersion?: string | number,
): number {
  const key = buildProgressKey(context, fileId);
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return 0;
    let rec: ResumeRecord | null;
    try {
      rec = JSON.parse(raw);
    } catch {
      localStorage.removeItem(key); // 损坏记录：清除后从头播放
      return 0;
    }
    if (!rec || typeof rec.t !== 'number' || typeof rec.d !== 'number' || typeof rec.ts !== 'number') {
      localStorage.removeItem(key);
      return 0;
    }
    if (!Number.isFinite(rec.t) || !Number.isFinite(rec.d) || rec.t <= 0 || rec.d <= 0) {
      localStorage.removeItem(key);
      return 0;
    }
    // 内容版本校验：覆盖上传后旧进度必须失效
    if (contentVersion !== undefined) {
      if (rec.v === undefined || rec.v !== contentVersion) {
        localStorage.removeItem(key);
        return 0;
      }
    }
    if (Date.now() - rec.ts > PROGRESS_TTL_MS) {
      localStorage.removeItem(key);
      return 0;
    }
    if (rec.t < RESUME_MIN_SEC || rec.d - rec.t < RESUME_TAIL_SEC) return 0;
    return Math.min(rec.t, Math.max(0, rec.d - 1));
  } catch {
    return 0;
  }
}

/** 定期清理过期 / 损坏的进度记录，避免 localStorage 无限增长 */
function pruneExpiredProgress() {
  try {
    const now = Date.now();
    const keys: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && k.startsWith(PROGRESS_PREFIX)) keys.push(k);
    }
    for (const k of keys) {
      try {
        const rec = JSON.parse(localStorage.getItem(k) || 'null') as { ts?: number } | null;
        if (!rec || typeof rec.ts !== 'number' || now - rec.ts > PROGRESS_TTL_MS) {
          localStorage.removeItem(k);
        }
      } catch {
        localStorage.removeItem(k); // 无法解析视为损坏记录
      }
    }
  } catch {
    // 隐私模式 / 存储被禁用时忽略
  }
}

export const useMediaPlaybackStore = defineStore('mediaPlayback', () => {
  const session = ref<MediaSession | null>(null);
  /** 完整预览是否展开；false 表示已收起为迷你播放器（媒体继续播放） */
  const expanded = ref(true);
  /** 上传浮层是否可见；可见时迷你播放器从右下避让到左下 */
  const uploadPanelVisible = ref(false);
  const playState = ref<MediaPlayState>('paused');
  const currentTime = ref(0);
  const duration = ref(0);
  const volume = ref(0.5);
  const muted = ref(false);
  const playbackRate = ref(1);
  /** 非打断式提示（如播放异常）；供 UI 以 aria-live 播报 */
  const errorMessage = ref<string | null>(null);
  /** 本次打开 / 切换媒体时待应用的恢复点（loadedmetadata 后消费） */
  const pendingResume = ref(0);

  let bridge: MediaPlayerBridge | null = null;

  /** 是否支持持续播放（音视频）；图片/PDF/文本关闭即停止 */
  const isContinuous = computed(() => {
    const kind = session.value?.item.kind;
    return kind === 'video' || kind === 'audio';
  });

  /** 错误提示自动清除计时器（非打断式反馈，短时展示后自动消失） */
  let errorTimer: ReturnType<typeof setTimeout> | null = null;

  // ─── 状态同步（由 FilePreviewDialog / MiniMediaPlayer 上报） ───
  function setPlayState(state: MediaPlayState) {
    playState.value = state;
  }

  function setProgress(t: number, d: number) {
    if (Number.isFinite(t) && t >= 0) currentTime.value = t;
    if (Number.isFinite(d) && d > 0) duration.value = d;
  }

  function setVolume(v: number) {
    volume.value = v;
  }

  function setMuted(v: boolean) {
    muted.value = v;
  }

  function setPlaybackRate(r: number) {
    playbackRate.value = r;
  }

  function setUploadPanelVisible(v: boolean) {
    uploadPanelVisible.value = v;
  }

  function setError(msg: string | null) {
    if (errorTimer) {
      clearTimeout(errorTimer);
      errorTimer = null;
    }
    errorMessage.value = msg;
    if (msg) {
      errorTimer = setTimeout(() => {
        errorMessage.value = null;
        errorTimer = null;
      }, 4500);
    }
  }

  // ─── 进度持久化 ───
  let persistCount = 0;

  function persistProgress() {
    const s = session.value;
    if (!s) return;
    if (s.item.kind !== 'video' && s.item.kind !== 'audio') return;
    if (currentTime.value <= 0 || duration.value <= 0) return;
    try {
      localStorage.setItem(buildProgressKey(s.context, s.item.id), JSON.stringify({
        t: currentTime.value,
        d: duration.value,
        ts: Date.now(),
        v: s.item.contentVersion,
      }));
      // 周期性清理过期记录（约每 100 次写入），控制存储体积
      if (++persistCount >= 100) {
        persistCount = 0;
        pruneExpiredProgress();
      }
    } catch {
      // 隐私模式 / 存储被禁用时忽略，不影响播放
    }
  }

  // ─── 会话生命周期 ───
  function open(payload: MediaSession) {
    session.value = payload;
    expanded.value = true;
    playState.value = 'buffering';
    currentTime.value = 0;
    duration.value = 0;
    errorMessage.value = null;
    pendingResume.value = readResumePoint(payload.context, payload.item.id, payload.item.contentVersion);
  }

  /** 播放列表切换到指定项；返回新项（供宿主更新 UI），越界返回 null */
  function switchTo(idx: number): MediaSessionItem | null {
    const s = session.value;
    if (!s || idx < 0 || idx >= s.playlist.length) return null;
    const item = s.playlist[idx];
    s.playlistIndex = idx;
    s.item = item;
    playState.value = 'buffering';
    currentTime.value = 0;
    duration.value = 0;
    errorMessage.value = null;
    pendingResume.value = readResumePoint(s.context, item.id, item.contentVersion);
    return item;
  }

  /** 收起为迷你播放器；仅对音视频生效，其他类型视为停止 */
  function minimize() {
    if (!isContinuous.value) {
      requestStop();
      return;
    }
    persistProgress();
    expanded.value = false;
  }

  function expand() {
    if (!session.value) return;
    expanded.value = true;
  }

  /** 真正停止：通过桥接层释放媒体资源后清空会话 */
  function requestStop() {
    if (bridge) {
      bridge.stop();
      return;
    }
    clearSession();
  }

  /** 清空会话与全部状态（媒体资源最终 teardown 由宿主 / 桥接层完成） */
  function clearSession() {
    persistProgress();
    if (errorTimer) {
      clearTimeout(errorTimer);
      errorTimer = null;
    }
    session.value = null;
    expanded.value = true;
    playState.value = 'paused';
    currentTime.value = 0;
    duration.value = 0;
    pendingResume.value = 0;
    errorMessage.value = null;
  }

  // ─── 播放控制桥（转发到实际媒体实例） ───
  function registerBridge(b: MediaPlayerBridge) {
    bridge = b;
  }

  function unregisterBridge() {
    bridge = null;
  }

  function play() { bridge?.play(); }
  function pause() { bridge?.pause(); }
  function togglePlay() { bridge?.togglePlay(); }
  function seekTo(t: number) { bridge?.seekTo(t); }
  function seekBy(s: number) { bridge?.seekBy(s); }
  function next() { bridge?.next(); }
  function prev() { bridge?.prev(); }

  return {
    session,
    expanded,
    uploadPanelVisible,
    playState,
    currentTime,
    duration,
    volume,
    muted,
    playbackRate,
    errorMessage,
    pendingResume,
    isContinuous,
    open,
    switchTo,
    minimize,
    expand,
    requestStop,
    clearSession,
    setPlayState,
    setProgress,
    setVolume,
    setMuted,
    setPlaybackRate,
    setUploadPanelVisible,
    setError,
    persistProgress,
    registerBridge,
    unregisterBridge,
    play,
    pause,
    togglePlay,
    seekTo,
    seekBy,
    next,
    prev,
  };
});
