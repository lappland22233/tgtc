/**
 * 播放列表控制 composable
 *
 * 职责：
 * - 播放列表导航（上一项 / 下一项 / 指定项切换）。
 * - 视频结束行为（loop / next / pause）与 localStorage 持久化。
 * - 自动下一曲计时器管理与键盘/面板点击收起联动。
 *
 * 依赖注入（保持与宿主解耦）：
 * - mediaStore：全局会话与播放状态。
 * - snap：只读 kind，派生播放列表集合语义。
 * - applyItem：切换到指定项后的内容加载协调（由宿主实现）。
 * - getVideoRef / getAudioRef / getPlaylistPanelRef：宿主媒体元素访问器。
 */
import { computed, nextTick, ref } from 'vue';
import type { PreviewKind } from '../utils/preview';
import type { MediaSessionItem } from '../stores/mediaPlayback';
import type { useMediaPlaybackStore } from '../stores/mediaPlayback';
import type { VideoEndBehavior } from '../components/file/CustomVideoPlayer.vue';

/** 宿主快照的最小形状（本模块只关心 kind） */
export interface PreviewSnapLike {
  kind: PreviewKind | null;
}

export interface PlaylistControlsOptions {
  mediaStore: ReturnType<typeof useMediaPlaybackStore>;
  snap: PreviewSnapLike;
  /** 切换到指定项后应用内容（宿主协调文本/图片/视频加载） */
  applyItem: (item: MediaSessionItem) => void;
  /** 激活视频真实媒体源并置 autoplay 意图，src 就绪后自动续播（宿主实现） */
  activateVideo: () => void;
  getVideoRef: () => HTMLVideoElement | null;
  getAudioRef: () => HTMLAudioElement | null;
  getPlaylistPanelRef: () => HTMLElement | null;
}

const VIDEO_END_BEHAVIOR_KEY = 'file-preview-video-end-behavior';
const VIDEO_END_BEHAVIORS: readonly VideoEndBehavior[] = ['loop', 'next', 'pause'];

function loadVideoEndBehavior(): VideoEndBehavior {
  try {
    const saved = localStorage.getItem(VIDEO_END_BEHAVIOR_KEY);
    if (VIDEO_END_BEHAVIORS.includes(saved as VideoEndBehavior)) return saved as VideoEndBehavior;
  } catch { /* 隐私模式或存储被禁用时使用默认值 */ }
  return 'next';
}

export function usePlaylistControls(options: PlaylistControlsOptions) {
  const { mediaStore, snap, applyItem, activateVideo, getVideoRef, getAudioRef, getPlaylistPanelRef } = options;

  /** 会话中的播放列表（与当前媒体同类别） */
  const playlist = computed<MediaSessionItem[]>(() => mediaStore.session?.playlist ?? []);
  const hasPlaylist = computed(() => playlist.value.length > 1);
  const activeIndex = computed(() => mediaStore.session?.playlistIndex ?? -1);
  const hasPrev = computed(() => activeIndex.value > 0);
  const hasNext = computed(() => activeIndex.value < playlist.value.length - 1);

  const isMediaCollection = computed(() => snap.kind === 'video' || snap.kind === 'audio' || snap.kind === 'image');
  const isContinuousMedia = computed(() => snap.kind === 'video' || snap.kind === 'audio');
  const collectionItemLabel = computed(() => snap.kind === 'audio' ? '音乐' : snap.kind === 'image' ? '图片' : '视频');
  const collectionTitle = computed(() => snap.kind === 'audio' ? '音乐播放列表' : snap.kind === 'image' ? '图片列表' : '视频播放列表');
  const playlistOpen = ref(false);

  const videoEndBehavior = ref<VideoEndBehavior>(loadVideoEndBehavior());
  let autoNextTimer: ReturnType<typeof setTimeout> | null = null;

  function setVideoEndBehavior(behavior: VideoEndBehavior) {
    videoEndBehavior.value = behavior;
    try { localStorage.setItem(VIDEO_END_BEHAVIOR_KEY, behavior); } catch { /* 不影响播放 */ }
  }

  function clearAutoNextTimer() {
    if (!autoNextTimer) return;
    clearTimeout(autoNextTimer);
    autoNextTimer = null;
  }

  /** 切换到列表中指定项：先更新全局会话（迷你播放器同步），再同步本地渲染状态 */
  function switchToTrack(idx: number) {
    const item = mediaStore.switchTo(idx);
    if (!item) return;
    clearAutoNextTimer();
    playlistOpen.value = false;
    applyItem(item);
    if (item.kind === 'audio') {
      nextTick(() => { void getAudioRef()?.play().catch(() => {}); });
    } else if (item.kind === 'video') {
      // 视频：置 autoplay 意图并激活真实媒体源，src 就绪后自动续播，避免连播断流停在封面
      nextTick(() => activateVideo());
    }
  }

  function playPrev() { if (hasPrev.value) switchToTrack(activeIndex.value - 1); }
  function playNext() { if (hasNext.value) switchToTrack(activeIndex.value + 1); }

  /** 播放列表展开后，点击面板之外的弹窗区域立即收起，不遮挡媒体。 */
  function onDialogPointerDown(event: PointerEvent) {
    if (!playlistOpen.value) return;
    const target = event.target as Node | null;
    if (target && getPlaylistPanelRef()?.contains(target)) return;
    const toggle = (target as Element | null)?.closest?.('.fpv-playlist-toggle');
    if (toggle) return;
    playlistOpen.value = false;
  }

  /** 视频开始播放 → 同步全局播放状态（迷你播放器据此切换播放/暂停图标） */
  function onVideoPlay() {
    mediaStore.setPlayState('playing');
  }

  /** 根据用户选择处理视频结束：单集循环、自动下一个或停在结尾。 */
  function onVideoEnded() {
    clearAutoNextTimer();
    mediaStore.setPlayState('ended');
    mediaStore.persistProgress();
    if (videoEndBehavior.value === 'loop') {
      const video = getVideoRef();
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

  function onVideoPaused() {
    mediaStore.setPlayState('paused');
    mediaStore.persistProgress();
  }

  return {
    playlist,
    hasPlaylist,
    activeIndex,
    hasPrev,
    hasNext,
    isMediaCollection,
    isContinuousMedia,
    collectionItemLabel,
    collectionTitle,
    playlistOpen,
    videoEndBehavior,
    setVideoEndBehavior,
    clearAutoNextTimer,
    switchToTrack,
    playPrev,
    playNext,
    onDialogPointerDown,
    onVideoPlay,
    onVideoEnded,
    onVideoPaused,
  };
}
