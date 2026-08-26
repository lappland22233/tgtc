<template>
  <teleport to="body">
      <div
        class="fpv-overlay"
        :class="{ 'fpv-overlay--minimized': !mediaStore.expanded }"
        :inert="!mediaStore.expanded"
        role="presentation"
        @click.self="fullStop"
      >
        <div
          ref="dialogRef"
          tabindex="-1"
          class="fpv-dialog"
          :class="`fpv-dialog--${snap.kind || 'unknown'}`"
          role="dialog"
          aria-modal="true"
          :aria-label="snap.name || '文件预览'"
          @pointerdown="onDialogPointerDown"
        >
          <!-- 头部：文件名 + 播放列表导航 + 最小化/关闭 -->
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
              <!-- 最小化：仅音视频持续播放时可用（其余类型等价于关闭） -->
              <button
                v-if="isContinuousMedia"
                type="button"
                class="fpv-nav-btn"
                aria-label="收起为迷你播放器（继续播放）"
                title="收起为迷你播放器（继续播放）"
                @click="minimize"
              >
                <t-icon name="chevron-down" />
              </button>
              <button type="button" class="fpv-close" aria-label="关闭预览" @click="fullStop">
                <t-icon name="close" />
              </button>
            </div>
          </div>

          <!-- 内容区：按 kind 分支渲染；弹窗收起（v-show）时媒体 DOM 保留不中断 -->
          <div class="fpv-body">
            <!-- 图片：自定义查看器（缩放 / 旋转 / 适应窗口 / 拖拽） -->
            <div
              v-if="snap.kind === 'image' && snap.src && !mediaError"
              class="fpv-image-stage"
              ref="imageStageRef"
              @dblclick="toggleImageFit"
              @wheel="onImageWheel"
              @pointerdown="onImagePointerDown"
              @pointermove="onImagePointerMove"
              @pointerup="onImagePointerUp"
              @pointercancel="onImagePointerUp"
            >
              <div v-if="imageDecoding" class="fpv-image-loading">
                <t-loading size="small" text="正在解码大图…" />
              </div>
              <img
                v-if="imageDisplaySrc"
                class="fpv-image"
                :class="{ 'fpv-image--dragging': imageDragging }"
                :src="imageDisplaySrc"
                :alt="snap.name"
                decoding="async"
                loading="eager"
                :style="imageStyle"
                @load="onImageLoad"
                @error="onMediaError"
                draggable="false"
              />

              <!-- 图片工具栏（缩放 / 适应 / 旋转 / 下载 / 更多） -->
              <div class="fpv-image-toolbar" @click.stop @pointerdown.stop>
                <button
                  type="button"
                  class="fpv-image-tool"
                  :disabled="imageScale <= IMAGE_SCALE_MIN"
                  aria-label="缩小"
                  title="缩小 (-)"
                  @click="zoomImageBy(-1)"
                >
                  <svg viewBox="0 0 24 24" width="18" height="18"><circle cx="11" cy="11" r="7" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="m21 21-4.35-4.35M8 11h6" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>
                </button>
                <span class="fpv-image-scale" :title="'点击切换：适应 / 100% / 200%'">{{ imageScaleText }}</span>
                <button
                  type="button"
                  class="fpv-image-tool"
                  :disabled="imageScale >= IMAGE_SCALE_MAX"
                  aria-label="放大"
                  title="放大 (+)"
                  @click="zoomImageBy(1)"
                >
                  <svg viewBox="0 0 24 24" width="18" height="18"><circle cx="11" cy="11" r="7" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="m21 21-4.35-4.35M8 11h6M11 8v6" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>
                </button>
                <span class="fpv-image-toolbar-divider" />
                <button
                  type="button"
                  class="fpv-image-tool"
                  aria-label="适应窗口"
                  :title="'适应窗口 / 实际尺寸 (1)'"
                  @click="toggleImageFit"
                >
                  <svg viewBox="0 0 24 24" width="18" height="18"><path d="M8 3H5a2 2 0 0 0-2 2v3m18 0V5a2 2 0 0 0-2-2h-3m0 18h3a2 2 0 0 0 2-2v-3M3 16v3a2 2 0 0 0 2 2h3" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>
                </button>
                <button
                  type="button"
                  class="fpv-image-tool"
                  aria-label="旋转"
                  title="顺时针旋转 90° (R)"
                  @click="rotateImage"
                >
                  <svg viewBox="0 0 24 24" width="18" height="18"><path d="M21 12a9 9 0 1 1-9-9c2.52 0 4.93 1 6.74 2.74L21 8" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/><path d="M21 3v5h-5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>
                </button>
                <button
                  type="button"
                  class="fpv-image-tool"
                  aria-label="重置视图"
                  title="重置视图 (0)"
                  @click="resetImageView"
                >
                  <svg viewBox="0 0 24 24" width="18" height="18"><path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/><path d="M3 3v5h5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>
                </button>
                <span class="fpv-image-toolbar-divider" />
                <button
                  type="button"
                  class="fpv-image-tool"
                  aria-label="下载"
                  title="下载"
                  @click="handleDownload"
                >
                  <svg viewBox="0 0 24 24" width="18" height="18"><path d="M12 3v12m0 0 4-4m-4 4-4-4M4 21h16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>
                </button>
              </div>
            </div>

            <!-- 视频：自定义播放器（MSE 优先，不支持时原生回退） -->
            <div
              v-else-if="snap.kind === 'video' && snap.src && !mediaError"
              class="fpv-video-wrap"
            >
              <CustomVideoPlayer
                ref="videoPlayerRef"
                :src="videoSrc"
                :poster="snap.kind === 'video' ? posterUrl : null"
                :cold="coldLoad"
                :end-behavior="videoEndBehavior"
                :initial-time="mediaStore.pendingResume"
                :interactive="mediaStore.expanded"
                @update:end-behavior="setVideoEndBehavior"
                @video-ref="onCustomPlayerVideoRef"
                @request-play="activateVideo"
                @play="onVideoPlay"
                @pause="onVideoPaused"
                @ended="onVideoEnded"
                @seeking-change="onVideoSeekingChange"
                @error="onVideoError"
              />
            </div>

            <!-- 音频：完全自定义播放器（隐藏原生 audio，仅作媒体内核；可见交互全部自绘） -->
            <div
              v-else-if="snap.kind === 'audio' && snap.src && !mediaError"
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

              <!-- 自定义进度条（可点击 / 拖动跳转；Pointer Events 统一鼠标与触屏） -->
              <div
                class="fpv-audio-progress"
                role="slider"
                tabindex="0"
                aria-label="音频进度"
                :aria-valuemin="0"
                :aria-valuemax="Math.max(0, Math.round(audioDuration))"
                :aria-valuenow="Math.max(0, Math.round(audioDisplayTime))"
                :aria-valuetext="`${formatAudioTime(audioDisplayTime)} / ${formatAudioTime(audioDuration)}`"
                @keydown.left.prevent="seekAudioBy(-5)"
                @keydown.right.prevent="seekAudioBy(5)"
                @pointerdown="onAudioProgressDown"
                @pointermove="onAudioProgressMove"
                @pointerup="onAudioProgressUp"
                @pointercancel="onAudioProgressCancel"
              >
                <div class="fpv-audio-progress-track">
                  <div class="fpv-audio-progress-played" :style="{ width: audioProgressPct + '%' }" />
                </div>
                <div class="fpv-audio-progress-thumb" :style="{ left: audioProgressPct + '%' }" />
              </div>

              <!-- 时间行 -->
              <div class="fpv-audio-time-row">
                <span class="fpv-audio-time-current">{{ formatAudioTime(audioDisplayTime) }}</span>
                <span class="fpv-audio-time-duration">{{ formatAudioTime(audioDuration) }}</span>
              </div>

              <!-- 主控制行 -->
              <div class="fpv-audio-controls-row">
                <button
                  type="button"
                  class="fpv-audio-btn"
                  :disabled="!hasPrev"
                  aria-label="上一首"
                  title="上一首 (Shift+P)"
                  @click="playPrev"
                >
                  <svg viewBox="0 0 24 24" width="20" height="20"><path d="m15 18-6-6 6-6" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>
                </button>
                <button
                  type="button"
                  class="fpv-audio-btn fpv-audio-btn--play"
                  :aria-label="audioPlaying ? '暂停' : '播放'"
                  :title="audioPlaying ? '暂停' : '播放'"
                  @click="toggleAudioPlay"
                >
                  <svg v-if="audioPlaying" viewBox="0 0 24 24" width="22" height="22"><path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z" fill="currentColor"/></svg>
                  <svg v-else viewBox="0 0 24 24" width="22" height="22"><path d="M8 5v14l11-7z" fill="currentColor"/></svg>
                </button>
                <button
                  type="button"
                  class="fpv-audio-btn"
                  :disabled="!hasNext"
                  aria-label="下一首"
                  title="下一首 (Shift+N)"
                  @click="playNext"
                >
                  <svg viewBox="0 0 24 24" width="20" height="20"><path d="m9 6 6 6-6 6" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>
                </button>

                <span class="fpv-audio-controls-spacer" />

                <!-- 静音 -->
                <button
                  type="button"
                  class="fpv-audio-btn"
                  :aria-label="audioMuted ? '取消静音' : '静音'"
                  :title="audioMuted ? '取消静音' : '静音'"
                  @click="toggleAudioMute"
                >
                  <svg v-if="audioMuted || audioVolume === 0" viewBox="0 0 24 24" width="20" height="20"><path d="M16.5 12A4.5 4.5 0 0 0 14 8.5v2.09l2.41 2.41c.06-.31.09-.63.09-1zM19 12c0 .94-.2 1.82-.54 2.64l1.51 1.51A8.796 8.796 0 0 0 21 12c0-4.28-2.99-7.86-7-8.77v2.06c2.89.86 5 3.54 5 6.71zM4.27 3 3 4.27 7.73 9H3v6h4l5 5v-6.73l4.25 4.25c-.67.52-1.42.93-2.25 1.18v2.06a8.99 8.99 0 0 0 3.69-1.81L19.73 21 21 19.73l-9-9L4.27 3zM12 4 9.91 6.09 12 8.18V4z" fill="currentColor"/></svg>
                  <svg v-else viewBox="0 0 24 24" width="20" height="20"><path d="M3 9v6h4l5 5V4L7 9H3zm13.5 3A4.5 4.5 0 0 0 14 8.5v7a4.47 4.47 0 0 0 2.5-3.5z" fill="currentColor"/></svg>
                </button>

                <!-- 倍速 -->
                <button
                  type="button"
                  class="fpv-audio-rate"
                  :aria-label="`播放速度 ${audioRate}×`"
                  title="播放速度"
                  @click="cycleAudioRate"
                >
                  {{ audioRate }}×
                </button>

                <!-- 音量滑块（触控端点击静音为主，桌面端悬浮弹出） -->
                <input
                  v-model.number="audioVolumeInput"
                  class="fpv-audio-volume"
                  type="range"
                  min="0"
                  max="1"
                  step="0.01"
                  aria-label="音量"
                  @input="onAudioVolumeInput"
                />

                <!-- 收起 -->
                <button
                  type="button"
                  class="fpv-audio-btn"
                  aria-label="收起为迷你播放器"
                  title="收起为迷你播放器"
                  @click="minimize"
                >
                  <svg viewBox="0 0 24 24" width="20" height="20"><path d="m6 9 6 6 6-6" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>
                </button>
              </div>

              <!-- 隐藏的媒体内核：波形/桥接仍依赖它，所有可见交互由上方自定义控件接管 -->
              <audio
                ref="audioRef"
                :key="snap.src"
                class="fpv-audio-core"
                :src="snap.src"
                preload="metadata"
                @play="onAudioPlay"
                @pause="onAudioPause"
                @ended="onAudioEnded"
                @timeupdate="onAudioTimeUpdate"
                @loadedmetadata="onAudioLoadedMeta"
                @volumechange="onAudioVolumeChange"
                @error="onMediaError"
              />
            </div>

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
              <p>{{ mediaError ? (mediaErrorText || '文件加载失败') : '无法预览该文件' }}</p>
              <template v-if="mediaError">
                <button type="button" class="fpv-btn" @click="retryMedia">
                  <t-icon name="refresh" />重试
                </button>
                <button type="button" class="fpv-btn fpv-btn--ghost" @click="handleDownload">
                  <t-icon name="download" />下载文件
                </button>
              </template>
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
                <button
                  v-for="(item, idx) in playlist"
                  :key="item.id"
                  type="button"
                  class="fpv-playlist-item"
                  :class="{ 'fpv-playing': idx === activeIndex, 'fpv-playlist-item--image': snap.kind === 'image' }"
                  :aria-current="idx === activeIndex ? 'true' : undefined"
                  :aria-label="`${idx === activeIndex ? '当前播放：' : '播放'}${item.name}`"
                  @click="switchToTrack(idx)"
                >
                  <ThumbnailImg
                    v-if="snap.kind === 'image'"
                    class="fpv-playlist-thumb"
                    :file-id="item.id"
                    :mime-type="item.mimeType"
                    :file-name="item.name"
                    :size="48"
                    :context="currentMediaContext()"
                    :version="item.contentVersion"
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
                </button>
              </div>
            </div>
          </transition>
        </div>
      </div>
  </teleport>
</template>

<script setup lang="ts">
import { ref, reactive, watch, nextTick, computed, onMounted, onBeforeUnmount } from 'vue';
import type { PreviewKind } from '../../utils/preview';
import { triggerBrowserDownload } from '../../utils/download';
import CustomVideoPlayer from './CustomVideoPlayer.vue';
import ThumbnailImg from '../ThumbnailImg.vue';
import {
  useMediaPlaybackStore,
  type MediaPlayerBridge,
  type MediaSession,
  type MediaSessionItem,
} from '../../stores/mediaPlayback';
import { usePreviewPoster } from '../../composables/usePreviewPoster';
import { usePreviewText } from '../../composables/usePreviewText';
import { usePlaylistControls } from '../../composables/usePlaylistControls';

const mediaStore = useMediaPlaybackStore();

/** 打开时快照：收起/切换后遮罩淡出期间内容不闪变 */
const snap = reactive({
  name: '',
  mimeType: '',
  size: null as number | null,
  kind: null as PreviewKind | null,
  src: null as string | null,
  downloadUrl: null as string | null,
});

/** 会话代次：切换 / 重置 / 文本加载时递增，使旧的异步任务统一失效 */
const sessionEpoch = ref(0);

const mediaError = ref(false);
/** 视频跳转尚未由媒体内核确认时，暂停同步旧播放进度。 */
const videoSeeking = ref(false);
/** 媒体加载失败的具体原因分类（优于笼统默认文案） */
const mediaErrorText = ref<string | null>(null);
const dialogRef = ref<HTMLElement | null>(null);
const playlistPanelRef = ref<HTMLElement | null>(null);

const poster = usePreviewPoster({ mediaStore, snap, epoch: sessionEpoch });
const {
  posterUrl,
  coldLoad,
  currentMediaContext,
  clearPosterRetryTimer,
  releasePosterResource,
  retryPosterAfterCache,
  startPosterForFile,
  resetPoster,
  checkColdStatus,
} = poster;

const textPreview = usePreviewText({ epoch: sessionEpoch });
const {
  textLoading,
  textContent,
  textError,
  textTooLarge,
  textCharCount,
  loadText,
  resetText,
  abortText,
} = textPreview;

const audioRef = ref<HTMLAudioElement | null>(null);

const playlistControls = usePlaylistControls({
  mediaStore,
  snap,
  applyItem,
  activateVideo,
  getVideoRef: () => videoRef.value,
  getAudioRef: () => audioRef.value,
  getPlaylistPanelRef: () => playlistPanelRef.value,
});
const {
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
} = playlistControls;

/** 根据播放项同步快照并按媒体类型重新加载内容 */
function applyItem(item: MediaSessionItem) {
  resetState();
  snap.name = item.name;
  snap.mimeType = item.mimeType;
  snap.size = item.size ?? null;
  snap.kind = item.kind;
  snap.src = item.src;
  snap.downloadUrl = item.downloadUrl ?? null;
  mediaError.value = false;
  if (item.kind === 'text') void loadText(item.src);
  if (item.kind === 'image') { resetImageView(); void setupImage(item.src); }
  if (item.kind === 'video') startPosterForFile(item.id);
}

// ============ 自定义音频控制 ============
/** 音频当前播放位置（由 timeupdate 驱动，供自定义进度条渲染） */
const audioCurrentTime = ref(0);
/** 音频总时长（loadedmetadata 后可用） */
const audioDuration = ref(0);
/** 音量（0-1，跟随 audio.volume；静音时归零显示） */
const audioVolume = ref(0.5);
/** 静音状态（跟随 audio.muted） */
const audioMuted = ref(false);
/** 倍速档位（与 CustomVideoPlayer 档位保持一致） */
const AUDIO_RATES = [0.5, 0.75, 1, 1.25, 1.5, 2, 3] as const;
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
  try { localStorage.setItem('file-preview-audio-rate', String(audioRate.value)); } catch { /* 不影响播放 */ }
}

// ============ 音频波形 ============
/** 音频是否正在播放（驱动波形装饰动画） */
const audioPlaying = ref(false);
const AUDIO_WAVE_BAR_COUNT = 28;
const AUDIO_WAVE_REFRESH_INTERVAL = 1000 / 45;
const audioWaveBars = ref(Array.from({ length: AUDIO_WAVE_BAR_COUNT }, () => ({ height: 28 })));
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
  audioWaveBars.value = Array.from({ length: AUDIO_WAVE_BAR_COUNT }, () => ({ height: 28 }));
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
  if (hasNext.value) switchToTrack(activeIndex.value + 1);
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
  throttlePersist();
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
  try {
    const saved = localStorage.getItem('file-preview-audio-rate');
    if (saved && AUDIO_RATES.includes(Number(saved) as (typeof AUDIO_RATES)[number])) {
      audioRate.value = Number(saved) as (typeof AUDIO_RATES)[number];
    }
  } catch { /* 存储不可用时使用默认 1× */ }
  a.playbackRate = audioRate.value;
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

function resetState() {
  sessionEpoch.value++;
  resetText();
  clearAutoNextTimer();
  resetPoster();
  teardownVideo();
  stopAudioWaveform();
  const audio = audioRef.value;
  if (audio) {
    audio.pause();
    audio.removeAttribute('src');
    audio.load();
  }
  audioPlaying.value = false;
  audioCurrentTime.value = 0;
  audioDuration.value = 0;
  audioSeeking.value = false;
  audioSeekDraft.value = null;
  // 图片查看状态复位（切换文件时避免上一张的缩放/旋转残留）
  if (imageDownsampleUrl) { URL.revokeObjectURL(imageDownsampleUrl); imageDownsampleUrl = null; }
  imageDisplaySrc.value = null;
  imageDecoding.value = false;
  imageLoaded.value = false;
  imageNatural.value = { w: 0, h: 0 };
  imageScale.value = 1;
  imageRotation.value = 0;
  imageFit.value = 'contain';
  imageTranslate.value = { x: 0, y: 0 };
  imageDragging.value = false;
  mediaError.value = false;
  mediaErrorText.value = null;
}

/** 收起为迷你播放器：音视频继续播放，其余类型直接停止 */
function minimize() {
  playlistOpen.value = false;
  mediaStore.minimize();
}

/** 真正停止：释放媒体资源并清空全局会话 */
function fullStop() {
  teardownVideo();
  stopAudioWaveform();
  const audio = audioRef.value;
  if (audio) {
    audio.pause();
    audio.removeAttribute('src');
    audio.load();
  }
  audioPlaying.value = false;
  mediaStore.clearSession();
}

/** Esc 键收起 + 播放列表快捷键 + Tab 焦点陷阱 */
function onKeydown(e: KeyboardEvent) {
  if (!mediaStore.expanded) return;
  if (e.key === 'Escape') {
    if (playlistOpen.value) playlistOpen.value = false;
    else fullStop();
    return;
  }
  // Tab 焦点陷阱：焦点保持在弹窗内循环，不越出到背景页面（G12-09）
  if (e.key === 'Tab') {
    const dialog = dialogRef.value;
    if (dialog) {
      const focusables = Array.from(
        dialog.querySelectorAll<HTMLElement>(
          'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
        ),
      );
      if (focusables.length > 0) {
        const first = focusables[0];
        const last = focusables[focusables.length - 1];
        const active = document.activeElement;
        if (e.shiftKey) {
          if (active === first || !dialog.contains(active)) {
            e.preventDefault();
            last.focus();
          }
        } else if (active === last || !dialog.contains(active)) {
          e.preventDefault();
          first.focus();
        }
      }
    }
    return;
  }
  // Shift+N / Shift+P → 当前媒体列表的下一项 / 上一项
  if (e.shiftKey && hasPlaylist.value) {
    if (e.key === 'N' || e.key === 'n') { e.preventDefault(); playNext(); }
    if (e.key === 'P' || e.key === 'p') { e.preventDefault(); playPrev(); }
  }
  // 音频专用快捷键：J/L 前后 10s，M 静音，上/下音量 ±5%
  if (snap.kind === 'audio') {
    if (e.key === 'j' || e.key === 'J') { e.preventDefault(); seekAudioBy(-10); }
    if (e.key === 'l' || e.key === 'L') { e.preventDefault(); seekAudioBy(10); }
    if (e.key === 'm' || e.key === 'M') { e.preventDefault(); toggleAudioMute(); }
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      const a = audioRef.value;
      if (a) { a.volume = Math.min(1, a.volume + 0.05); }
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      const a = audioRef.value;
      if (a) { a.volume = Math.max(0, a.volume - 0.05); }
    }
  }
  // 图片专用快捷键：+/= 放大，- 缩小，0 重置，1 适应/100%，R 旋转，左右切图
  if (snap.kind === 'image') {
    if (e.key === '+' || e.key === '=') { e.preventDefault(); zoomImageBy(1); }
    if (e.key === '-') { e.preventDefault(); zoomImageBy(-1); }
    if (e.key === '0') { e.preventDefault(); resetImageView(); }
    if (e.key === '1') { e.preventDefault(); toggleImageFit(); }
    if (e.key === 'r' || e.key === 'R') { e.preventDefault(); rotateImage(); }
    if (e.key === 'ArrowLeft') { e.preventDefault(); playPrev(); }
    if (e.key === 'ArrowRight') { e.preventDefault(); playNext(); }
  }
}

/** 页面隐藏时补写进度（避免后台期间丢失最后位置） */
function onVisibility() {
  if (document.visibilityState === 'hidden' && !audioSeeking.value) {
    mediaStore.persistProgress();
  }
}

/** 媒体元素加载失败（图片/音频/PDF 共用；仅 401/403 提示权限，其余可重试） */
function onMediaError() {
  mediaError.value = true;
  // 默认文案；仅当明确是权限类错误时才提示权限相关说明
  mediaErrorText.value = null;
}

/** 错误态重试：清除错误标记，重新加载当前媒体 */
function retryMedia() {
  mediaError.value = false;
  mediaErrorText.value = null;
  if (snap.kind === 'image') {
    // 图片重新走降采样加载链路
    void setupImage(snap.src);
  } else if (snap.kind === 'video') {
    teardownVideo();
    setupVideo();
    videoPlayerRef.value?.requestAutoplay?.();
  } else if (snap.kind === 'audio') {
    const a = audioRef.value;
    if (a) {
      a.pause();
      a.removeAttribute('src');
      a.load();
      a.src = snap.src || '';
      a.load();
    }
  }
}

/** 根据浏览器媒体错误码分类提示，避免笼统「无法播放」 */
function classifyMediaErrorCode(code?: number): string {
  switch (code) {
    case 2: // MEDIA_ERR_NETWORK
      return '网络错误，无法加载媒体，请检查网络后重试';
    case 3: // MEDIA_ERR_DECODE
      return '媒体解码失败，文件可能已损坏或编码格式不支持';
    case 4: // MEDIA_ERR_SRC_NOT_SUPPORTED
      return '无法加载媒体，文件可能已被删除或格式不支持';
    default:
      return '文件加载失败，请重试';
  }
}

// ============ 图片查看器（缩放 / 旋转 / 适应 / 拖拽） ============
const IMAGE_SCALE_MIN = 0.1;
const IMAGE_SCALE_MAX = 8;
/** 缩放档位步进比例（相对当前值，指数步进更符合视觉感受） */
const IMAGE_SCALE_STEP = 1.2;
const imageStageRef = ref<HTMLElement | null>(null);
const imageScale = ref(1);
const imageRotation = ref(0);
/** 视图模式：contain = 适应窗口；manual = 手动缩放（含 100% 实际尺寸） */
const imageFit = ref<'contain' | 'manual'>('contain');
const imageTranslate = ref({ x: 0, y: 0 });
const imageDragging = ref(false);
const imageNatural = ref({ w: 0, h: 0 });
const imageLoaded = ref(false);
/** 大图解码中（同步解码会阻塞主线程，改为异步 + 降采样） */
const imageDecoding = ref(false);
/** 实际渲染的图片地址：普通图直接用原图，超大图用 createImageBitmap 降采样后的 ObjectURL */
const imageDisplaySrc = ref<string | null>(null);
/** 降采样生成的 ObjectURL（需在切换/卸载时 revoke） */
let imageDownsampleUrl: string | null = null;
/** 大图降采样触发阈值（像素数） */
const IMAGE_DOWNSAMPLE_PIXEL_THRESHOLD = 4096 * 4096;
/** 拖拽起始点与初始偏移 */
let imageDragStart = { x: 0, y: 0, tx: 0, ty: 0 };

/** 旋转后是否发生宽高交换（90/270 度） */
const imageSwapped = computed(() => imageRotation.value % 180 !== 0);

/** 图片适应窗口的缩放比例（依据舞台尺寸与自然尺寸，旋转后交换宽高） */
const imageFitScale = computed(() => {
  const stage = imageStageRef.value;
  if (!stage || imageNatural.value.w <= 0 || imageNatural.value.h <= 0) return 1;
  const sw = stage.clientWidth;
  const sh = stage.clientHeight;
  if (sw <= 0 || sh <= 0) return 1;
  const iw = imageSwapped.value ? imageNatural.value.h : imageNatural.value.w;
  const ih = imageSwapped.value ? imageNatural.value.w : imageNatural.value.h;
  return Math.min(sw / iw, sh / ih, 1);
});

/** 当前实际缩放比例（手动模式直接用缩放值；适应模式用计算值） */
const imageCurrentScale = computed(() => (
  imageFit.value === 'contain' ? imageFitScale.value : imageScale.value
));

/** 图片元素 transform：先缩放后旋转，再平移 */
const imageStyle = computed(() => ({
  transform: `translate(${imageTranslate.value.x}px, ${imageTranslate.value.y}px) scale(${imageCurrentScale.value}) rotate(${imageRotation.value}deg)`,
}));

/** 工具栏缩放比例文案：适应模式显示「适应」，手动模式显示百分比 */
const imageScaleText = computed(() => {
  if (imageFit.value === 'contain') return '适应';
  return `${Math.round(imageScale.value * 100)}%`;
});

/**
 * 加载图片：先尝试异步解码并检测超大图，超阈值时用 createImageBitmap 降采样，
 * 避免超大图同步解码阻塞主线程导致白屏。切换/停止时通过代次令牌使旧任务失效。
 */
async function setupImage(src: string | null) {
  // 释放上一张降采样资源
  if (imageDownsampleUrl) {
    URL.revokeObjectURL(imageDownsampleUrl);
    imageDownsampleUrl = null;
  }
  imageDisplaySrc.value = null;
  imageDecoding.value = false;
  if (!src) return;
  const token = sessionEpoch.value;

  // 先异步探测图片尺寸（不阻塞主线程）
  const probe = await probeImageSize(src, token);
  if (token !== sessionEpoch.value) return;
  if (probe === null) {
    // 探测失败（非图片 / 网络失败）交由 <img> 的 error 事件处理
    imageDisplaySrc.value = src;
    return;
  }
  const pixels = probe.w * probe.h;
  if (pixels > IMAGE_DOWNSAMPLE_PIXEL_THRESHOLD) {
    // 超大图：createImageBitmap 降采样（限制边长为 2048，保持宽高比）
    imageDecoding.value = true;
    try {
      const bitmap = await createImageBitmap(await fetch(src, { credentials: 'same-origin' }).then((r) => {
        if (!r.ok) throw new Error('load failed');
        return r.blob();
      }), {
        resizeWidth: Math.round(probe.w * (2048 / Math.max(probe.w, probe.h))),
        resizeHeight: Math.round(probe.h * (2048 / Math.max(probe.w, probe.h))),
        resizeQuality: 'high',
      });
      if (token !== sessionEpoch.value) { bitmap.close(); return; }
      // ImageBitmap 不能直接作为 ObjectURL 源，先经 canvas 转成 Blob
      const canvas = document.createElement('canvas');
      canvas.width = bitmap.width;
      canvas.height = bitmap.height;
      const ctx = canvas.getContext('2d');
      if (!ctx) { bitmap.close(); throw new Error('canvas ctx unavailable'); }
      ctx.drawImage(bitmap, 0, 0);
      const blob: Blob = await new Promise((resolve) => canvas.toBlob((b) => resolve(b ?? new Blob()), 'image/png'));
      const naturalW = bitmap.width;
      const naturalH = bitmap.height;
      bitmap.close();
      if (token !== sessionEpoch.value) return;
      imageDownsampleUrl = URL.createObjectURL(blob);
      imageDisplaySrc.value = imageDownsampleUrl;
      // 用降采样尺寸作为自然尺寸
      imageNatural.value = { w: naturalW, h: naturalH };
      imageLoaded.value = true;
      resetImageView();
    } catch {
      if (token !== sessionEpoch.value) return;
      // 降采样失败回退原图（由 <img> 的 error/load 决定最终态）
      imageDisplaySrc.value = src;
    } finally {
      if (token === sessionEpoch.value) imageDecoding.value = false;
    }
  } else {
    // 普通图：直接使用原图，异步解码避免白屏
    imageDisplaySrc.value = src;
  }
}

/** 轻量探测图片尺寸（HEAD 或读数据），仅用于决定是否降采样；失败返回 null */
async function probeImageSize(src: string, token: number): Promise<{ w: number; h: number } | null> {
  try {
    const img = new Image();
    img.decoding = 'async';
    const loaded = new Promise<{ w: number; h: number }>((resolve, reject) => {
      img.onload = () => resolve({ w: img.naturalWidth, h: img.naturalHeight });
      img.onerror = () => reject(new Error('probe failed'));
    });
    img.src = src;
    const size = await loaded;
    if (token !== sessionEpoch.value) return null;
    return size;
  } catch {
    return null;
  }
}

function onImageLoad(e: Event) {
  const img = e.target as HTMLImageElement;
  imageNatural.value = { w: img.naturalWidth || 0, h: img.naturalHeight || 0 };
  imageLoaded.value = true;
  resetImageView();
}

/** 相对缩放：传入方向（-1 缩小 / +1 放大），保持中心点不漂移 */
function zoomImageBy(dir: -1 | 1) {
  const target = imageFit.value === 'contain'
    ? imageFitScale.value * (dir > 0 ? IMAGE_SCALE_STEP : 1 / IMAGE_SCALE_STEP)
    : imageScale.value * (dir > 0 ? IMAGE_SCALE_STEP : 1 / IMAGE_SCALE_STEP);
  zoomImageTo(target);
}

function zoomImageTo(scale: number) {
  imageFit.value = 'manual';
  imageScale.value = Math.min(IMAGE_SCALE_MAX, Math.max(IMAGE_SCALE_MIN, scale));
  clampImageTranslate();
}

/** 适应窗口 / 实际尺寸（100%）切换 */
function toggleImageFit() {
  if (imageFit.value === 'contain') {
    // 进入实际尺寸：以 100% 为基准，保留已有平移
    imageFit.value = 'manual';
    imageScale.value = 1;
  } else {
    imageFit.value = 'contain';
    imageTranslate.value = { x: 0, y: 0 };
  }
  clampImageTranslate();
}

/** 顺时针旋转 90°（旋转后平移量需重算，回到居中） */
function rotateImage() {
  imageRotation.value = (imageRotation.value + 90) % 360;
  imageTranslate.value = { x: 0, y: 0 };
  // 适应模式下重算适应比例；手动模式保持当前缩放
  if (imageFit.value === 'contain') imageScale.value = imageFitScale.value;
  clampImageTranslate();
}

/** 重置视图：适应窗口 + 归零旋转与平移 */
function resetImageView() {
  imageRotation.value = 0;
  imageTranslate.value = { x: 0, y: 0 };
  imageFit.value = 'contain';
  imageScale.value = imageFitScale.value;
}

/** 平移边界钳制：放大后图片边缘不能完全离开视口 */
function clampImageTranslate() {
  const stage = imageStageRef.value;
  if (!stage) return;
  const scale = imageCurrentScale.value;
  const iw = (imageSwapped.value ? imageNatural.value.h : imageNatural.value.w) * scale;
  const ih = (imageSwapped.value ? imageNatural.value.w : imageNatural.value.h) * scale;
  const sw = stage.clientWidth;
  const sh = stage.clientHeight;
  const maxX = Math.max(0, (iw - sw) / 2);
  const maxY = Math.max(0, (ih - sh) / 2);
  imageTranslate.value = {
    x: Math.min(maxX, Math.max(-maxX, imageTranslate.value.x)),
    y: Math.min(maxY, Math.max(-maxY, imageTranslate.value.y)),
  };
}

/** Ctrl/⌘ + 滚轮缩放（不抢占普通滚动） */
function onImageWheel(e: WheelEvent) {
  if (!e.ctrlKey && !e.metaKey) return;
  e.preventDefault();
  zoomImageBy(e.deltaY < 0 ? 1 : -1);
}

/** 指针按下：放大状态下启动拖拽 */
function onImagePointerDown(e: PointerEvent) {
  if (imageFit.value === 'contain' && imageCurrentScale.value <= imageFitScale.value + 0.001) return;
  imageDragging.value = true;
  imageDragStart = { x: e.clientX, y: e.clientY, tx: imageTranslate.value.x, ty: imageTranslate.value.y };
  (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
}

function onImagePointerMove(e: PointerEvent) {
  if (!imageDragging.value) return;
  imageTranslate.value = {
    x: imageDragStart.tx + (e.clientX - imageDragStart.x),
    y: imageDragStart.ty + (e.clientY - imageDragStart.y),
  };
}

function onImagePointerUp() {
  imageDragging.value = false;
  clampImageTranslate();
}

// ============ 视频预览（MSE 优先 + 原生回退） ============
const videoRef = ref<HTMLVideoElement | null>(null);
const videoPlayerRef = ref<InstanceType<typeof CustomVideoPlayer> | null>(null);

/** 进度节流持久化间隔 */
const PROGRESS_PERSIST_INTERVAL = 5000;
let lastPersist = 0;
function throttlePersist() {
  const now = Date.now();
  if (now - lastPersist >= PROGRESS_PERSIST_INTERVAL) {
    lastPersist = now;
    mediaStore.persistProgress();
  }
}

/**
 * 从 CustomVideoPlayer 获取内部 <video> 元素引用。
 * 绑定缓冲追踪与进度持久化所需的媒体事件监听。
 */
function onCustomPlayerVideoRef(el: HTMLVideoElement | null) {
  // 清理旧监听
  const old = videoRef.value;
  if (old) {
    old.removeEventListener('progress', updateBufferedRatio);
    old.removeEventListener('timeupdate', handleVideoTimeUpdate);
  }
  videoRef.value = el;
  if (el) {
    el.addEventListener('progress', updateBufferedRatio);
    el.addEventListener('timeupdate', handleVideoTimeUpdate);
  }
}

function handleVideoTimeUpdate() {
  onVideoTimeUpdate();
}

/** 视频跳转期间暂停采信旧位置；媒体确认后立即同步目标位置。 */
function onVideoSeekingChange(seeking: boolean) {
  videoSeeking.value = seeking;
  if (!seeking) onVideoTimeUpdate(true);
}

/** 视频进度同步 + 节流持久化 */
function onVideoTimeUpdate(forcePersist = false) {
  const v = videoRef.value;
  if (!v || videoSeeking.value) return;
  mediaStore.setProgress(v.currentTime, v.duration);
  if (forcePersist) {
    lastPersist = Date.now();
    mediaStore.persistProgress();
  } else {
    throttlePersist();
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
/** 冷资源缓存状态轮询定时器（缓存完成后提前解锁 seek，不必等全量下载） */
let coldCachePollTimer: ReturnType<typeof setInterval> | null = null;
/** 冷资源缓存状态轮询间隔 */
const COLD_CACHE_POLL_INTERVAL = 3000;

/** MSE 会话状态（非响应式，每次打开预览建立一个） */
interface MseSession {
  ms: MediaSource;
  objectUrl: string;
  sb: SourceBuffer | null;
  abort: AbortController | null;
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

/**
 * 用户首次明确播放后才激活真实媒体源。
 * 置 autoplay 意图（等效 CustomVideoPlayer 内部 pendingPlayRequest），
 * src 就绪后自动续播；对用户手动播放幂等，不影响现有行为。
 */
function activateVideo() {
  if (videoSrc.value || !snap.src) return;
  videoPlayerRef.value?.requestAutoplay?.();
  setupVideo();
}

/** 激活视频预览：MSE 优先，不支持时原生回退 */
function setupVideo() {
  const url = snap.src;
  if (!url) return;
  videoBuffering.value = true;
  videoBufferedRatio.value = 0;
  const mime = snap.mimeType || 'video/mp4';
  // 默认统一交给原生媒体元素按需发起 Range。保留旧 MSE 实现仅用于后续分段化改造。
  const enableLegacyMse = false;
  if (enableLegacyMse && mseTypeSupported(mime)) {
    startMseVideo(url, mime);
    return;
  }
  videoUseMse.value = false;
  videoSrc.value = url;
  startColdCachePoll();
}

/**
 * 冷资源 seek 解锁：全量缓冲完成（updateBufferedRatio 兜底）或并行轮询 cache-status
 * 发现缓存已就绪时提前解锁。轮询期间保持钳制，避免为越界位置发起动态分段请求。
 */
function startColdCachePoll() {
  stopColdCachePoll();
  if (!coldLoad.value) return;
  coldCachePollTimer = setInterval(() => {
    if (!coldLoad.value) { stopColdCachePoll(); return; }
    void checkColdStatus().then(() => {
      // checkColdStatus 会在 cache 就绪时把 coldLoad 置 false，随后停止轮询
      if (!coldLoad.value) stopColdCachePoll();
    });
  }, COLD_CACHE_POLL_INTERVAL);
}

function stopColdCachePoll() {
  if (coldCachePollTimer) {
    clearInterval(coldCachePollTimer);
    coldCachePollTimer = null;
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
      fallbackToNative();
    }
  };
  ms.addEventListener('sourceopen', s.onSourceOpen);
}

async function pumpMseStream(url: string) {
  const s = mseSession;
  if (!s) return;
  const ctrl = new AbortController();
  s.abort = ctrl;
  try {
    const res = await fetch(url, { credentials: 'same-origin', signal: ctrl.signal });
    if (mseSession !== s) return;
    if (!res.ok) {
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
      if (mseSession !== s) return;
      if (done) break;
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

function onAppendError(e: unknown, chunk: ArrayBuffer) {
  const s = mseSession;
  if (!s || !s.sb) return;
  const isQuota = e instanceof DOMException && e.name === 'QuotaExceededError';
  if (isQuota && !s.evictRetried && evictOldestBuffered(s.sb)) {
    s.evictRetried = true;
    s.queue.unshift(chunk);
    return;
  }
  fallbackToNative();
}

function evictOldestBuffered(sb: SourceBuffer): boolean {
  const v = videoRef.value;
  if (sb.updating || sb.buffered.length === 0) return false;
  const start = sb.buffered.start(0);
  let end = sb.buffered.end(0);
  if (v && v.currentTime > start) end = Math.min(end, Math.max(start, v.currentTime - 1));
  if (end <= start) return false;
  try { sb.remove(start, end); return true; } catch { return false; }
}

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

/** 切换媒体 / 真正停止 / 组件卸载：终止视频流并清理 */
function teardownVideo() {
  teardownMse();
  const v = videoRef.value;
  if (v) {
    v.removeEventListener('progress', updateBufferedRatio);
    v.removeEventListener('timeupdate', handleVideoTimeUpdate);
    // 中止拉流：移除 src 并 load()，立即停止正在进行的媒体请求（与音频路径对齐）
    v.pause();
    v.removeAttribute('src');
    v.load();
  }
  videoRef.value = null;
  videoSrc.value = null;
  videoUseMse.value = false;
  videoBuffering.value = false;
  videoBufferedRatio.value = 0;
  stopColdCachePoll();
}

/** video error：MSE 模式先降级原生；原生模式再失败则进错误态并分类提示 */
function onVideoError() {
  if (videoUseMse.value) {
    fallbackToNative();
    return;
  }
  mediaError.value = true;
  mediaErrorText.value = classifyMediaErrorCode(videoRef.value?.error?.code);
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
    stopColdCachePoll();
    void retryPosterAfterCache();
  }
}

/** 会话打开 / 切换 / 清空 → 同步快照与媒体内容 */
watch(() => mediaStore.session, (session: MediaSession | null) => {
  if (!session) {
    resetState();
    snap.name = '';
    snap.mimeType = '';
    snap.size = null;
    snap.kind = null;
    snap.src = null;
    snap.downloadUrl = null;
    return;
  }
  applyItem(session.item);
}, { immediate: true });

/** 展开时绑定快捷键并聚焦弹窗；收起/停止后解除 */
watch(() => mediaStore.expanded, (v) => {
  if (v) {
    window.addEventListener('keydown', onKeydown);
    nextTick(() => dialogRef.value?.focus({ preventScroll: true }));
  } else {
    window.removeEventListener('keydown', onKeydown);
  }
  // 收起为迷你播放器时暂停波形动画（音频仍在播放，避免隐藏状态空转 rAF）
  if (v) {
    if (audioPlaying.value && !audioWaveFrame) {
      audioWaveFrame = requestAnimationFrame(updateAudioWaveform);
    }
  } else if (audioWaveFrame) {
    cancelAnimationFrame(audioWaveFrame);
    audioWaveFrame = 0;
    audioWaveLastUpdate = 0;
  }
}, { immediate: true });

/** 播放控制桥：迷你播放器等外部 UI 通过 store 转发到同一媒体实例 */
const bridge: MediaPlayerBridge = {
  play() {
    if (snap.kind === 'video') void videoPlayerRef.value?.play();
    else void audioRef.value?.play().catch(() => {});
  },
  pause() {
    if (snap.kind === 'video') void videoPlayerRef.value?.pause();
    else audioRef.value?.pause();
  },
  togglePlay() {
    if (snap.kind === 'video') {
      videoPlayerRef.value?.togglePlay();
    } else {
      const a = audioRef.value;
      if (!a) return;
      if (a.paused) void a.play().catch(() => {});
      else a.pause();
    }
  },
  seekTo(t) {
    if (snap.kind === 'video' && videoRef.value) videoRef.value.currentTime = Math.max(0, t);
    else if (snap.kind === 'audio' && audioRef.value) audioRef.value.currentTime = Math.max(0, t);
  },
  seekBy(seconds) {
    const target = (snap.kind === 'video' ? videoRef.value?.currentTime : audioRef.value?.currentTime) ?? 0;
    this.seekTo((target || 0) + seconds);
  },
  next: playNext,
  prev: playPrev,
  stop: fullStop,
};

onMounted(() => {
  mediaStore.registerBridge(bridge);
  document.addEventListener('visibilitychange', onVisibility);
});

onBeforeUnmount(() => {
  window.removeEventListener('keydown', onKeydown);
  document.removeEventListener('visibilitychange', onVisibility);
  abortText();
  clearPosterRetryTimer();
  releasePosterResource();
  teardownVideo();
  stopAudioWaveform();
  if (imageDownsampleUrl) { URL.revokeObjectURL(imageDownsampleUrl); imageDownsampleUrl = null; }
  imageDisplaySrc.value = null;
  imageDecoding.value = false;
  audioPlaying.value = false;
  mediaStore.unregisterBridge();
});

/** 底部下载：优先使用会话中的 downloadUrl，否则用预览地址兜底 */
function handleDownload() {
  const url = snap.downloadUrl || snap.src;
  if (!url) return;
  triggerBrowserDownload(url, snap.name || undefined);
}

/**
 * 安全的文件大小格式化。
 * 后端/调用方可能传入字符串、空值或非法数值，统一先做数值归一化。
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
  transition: opacity var(--duration-normal) var(--ease-out-expo);
}

/* 收起为迷你播放器：隐藏遮罩但保留媒体渲染（避免媒体实例被卸载导致播放中断） */
.fpv-overlay--minimized {
  opacity: 0;
  pointer-events: none;
  backdrop-filter: none;
}

@media (prefers-reduced-motion: reduce) {
  .fpv-overlay {
    transition: none;
  }
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

/* ─── 图片查看器：舞台 + 变换 + 工具栏 ─── */
.fpv-image-stage {
  position: relative;
  width: 100%;
  height: 100%;
  min-height: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  overflow: hidden;
  background:
    radial-gradient(circle at 50% 40%, color-mix(in srgb, var(--seed-surface) 18%, transparent), transparent 70%),
    var(--seed-bg, #0b0d12);
  border-radius: var(--radius-sm, 6px);
  cursor: grab;
  touch-action: none;
  user-select: none;
}

.fpv-image-stage:active {
  cursor: grabbing;
}

.fpv-image {
  display: block;
  max-width: none;
  max-height: none;
  object-fit: contain;
  border-radius: var(--radius-sm, 6px);
  box-shadow: var(--shadow-md);
  will-change: transform;
  pointer-events: none;
  transform-origin: center center;
}

.fpv-image--dragging {
  transition: none;
}

/* 大图降采样加载中提示 */
.fpv-image-loading {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 3;
  background: color-mix(in srgb, var(--seed-bg, #0b0d12) 30%, transparent);
}

/* 图片工具栏：深色悬浮条（与视频控制栏同语言） */
.fpv-image-toolbar {
  position: absolute;
  left: 50%;
  bottom: 14px;
  transform: translateX(-50%);
  display: flex;
  align-items: center;
  gap: 2px;
  padding: 6px;
  background: color-mix(in srgb, var(--seed-bg, #0b0d12) 82%, transparent);
  backdrop-filter: blur(8px);
  border: 1px solid var(--border-default);
  border-radius: 999px;
  box-shadow: var(--shadow-md);
  z-index: 2;
}

.fpv-image-tool {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 36px;
  height: 36px;
  padding: 0;
  border: none;
  border-radius: 50%;
  background: transparent;
  color: var(--text-secondary);
  cursor: pointer;
  touch-action: manipulation;
  transition: background var(--duration-fast) ease, color var(--duration-fast) ease, transform 0.1s ease;
}

.fpv-image-tool:hover:not(:disabled) {
  background: var(--color-accent-soft);
  color: var(--text-accent);
}

.fpv-image-tool:active:not(:disabled) {
  transform: scale(0.92);
}

.fpv-image-tool:disabled {
  opacity: 0.35;
  cursor: default;
}

.fpv-image-scale {
  min-width: 52px;
  text-align: center;
  font-family: var(--font-mono);
  font-size: 12px;
  font-variant-numeric: tabular-nums;
  color: var(--text-secondary);
  cursor: default;
  user-select: none;
}

.fpv-image-toolbar-divider {
  width: 1px;
  height: 18px;
  margin: 0 4px;
  background: var(--border-default);
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

/* 隐藏的媒体内核：不渲染可见控件，仅供波形与播放桥使用 */
.fpv-audio-core {
  position: absolute;
  width: 1px;
  height: 1px;
  opacity: 0;
  pointer-events: none;
}

/* ─── 自定义进度条 ─── */
.fpv-audio-progress {
  position: relative;
  display: flex;
  align-items: center;
  width: 100%;
  height: 20px;
  cursor: pointer;
  touch-action: none;
}

.fpv-audio-progress-track {
  position: relative;
  width: 100%;
  height: 4px;
  border-radius: 999px;
  background: var(--border-strong);
  overflow: hidden;
}

.fpv-audio-progress-played {
  position: absolute;
  inset: 0 auto 0 0;
  width: 0;
  background: var(--seed-primary);
  border-radius: 999px;
}

.fpv-audio-progress-thumb {
  position: absolute;
  top: 50%;
  width: 12px;
  height: 12px;
  border-radius: 50%;
  background: var(--seed-surface);
  border: 2px solid var(--seed-primary);
  box-shadow: var(--shadow-sm);
  transform: translate(-50%, -50%);
  transition: opacity var(--duration-fast) ease;
  opacity: 0;
}

.fpv-audio-progress:hover .fpv-audio-progress-thumb,
.fpv-audio-progress:focus-visible .fpv-audio-progress-thumb {
  opacity: 1;
}

/* ─── 时间行 ─── */
.fpv-audio-time-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  font-family: var(--font-mono);
  font-size: 12px;
  font-variant-numeric: tabular-nums;
  color: var(--text-tertiary);
}

/* ─── 主控制行 ─── */
.fpv-audio-controls-row {
  display: flex;
  align-items: center;
  gap: 6px;
}

.fpv-audio-controls-spacer {
  flex: 1;
}

.fpv-audio-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 40px;
  height: 40px;
  flex-shrink: 0;
  padding: 0;
  border: none;
  border-radius: 50%;
  background: transparent;
  color: var(--text-secondary);
  cursor: pointer;
  touch-action: manipulation;
  transition: background var(--duration-fast) ease, color var(--duration-fast) ease, transform 0.1s ease;
}

.fpv-audio-btn:hover:not(:disabled) {
  background: var(--color-accent-soft);
  color: var(--text-accent);
}

.fpv-audio-btn:active:not(:disabled) {
  transform: scale(0.92);
}

.fpv-audio-btn:disabled {
  color: var(--text-disabled);
  cursor: default;
  opacity: 0.45;
}

.fpv-audio-btn--play {
  width: 48px;
  height: 48px;
  background: var(--seed-primary);
  color: #fff;
  box-shadow: var(--shadow-sm);
}

.fpv-audio-btn--play:hover:not(:disabled) {
  background: color-mix(in srgb, var(--seed-primary) 88%, #fff);
  color: #fff;
}

/* 倍速胶囊 */
.fpv-audio-rate {
  min-width: 52px;
  height: 32px;
  padding: 0 10px;
  border: 1px solid var(--border-default);
  border-radius: 999px;
  background: var(--color-bg-elevated);
  color: var(--text-secondary);
  font-family: var(--font-mono);
  font-size: 12px;
  cursor: pointer;
  transition: border-color var(--duration-fast) ease, color var(--duration-fast) ease, background var(--duration-fast) ease;
}

.fpv-audio-rate:hover {
  border-color: var(--seed-primary);
  color: var(--text-accent);
  background: var(--color-accent-soft);
}

/* 音量滑块（细窄轨道，桌面端可用） */
.fpv-audio-volume {
  width: 72px;
  height: 20px;
  accent-color: var(--seed-primary);
  cursor: pointer;
  flex-shrink: 0;
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

/* 次要按钮（错误态下载） */
.fpv-btn--ghost {
  background: transparent;
  border: 1px solid var(--border-strong);
  color: var(--text-secondary);
}
.fpv-btn--ghost:hover {
  background: var(--color-accent-soft);
  color: var(--text-accent);
}

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
  width: 100%;
  padding: 8px 14px;
  border: 0;
  background: transparent;
  font: inherit;
  text-align: left;
  cursor: pointer;
  transition: background 0.15s;
  position: relative;
  color: var(--text-primary);
}
.fpv-playlist-item:focus-visible {
  outline: 2px solid var(--color-accent);
  outline-offset: -2px;
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
    width: min(100%, 640px);
    height: auto;
    max-height: calc(100dvh - 16px);
    border-radius: var(--radius-sm, 6px);
  }

  .fpv-dialog--video,
  .fpv-dialog--image {
    height: min(72dvh, 560px);
  }

  .fpv-dialog--pdf,
  .fpv-dialog--text {
    height: min(82dvh, 680px);
  }

  .fpv-dialog--audio {
    width: min(100%, 520px);
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
    padding: 16px 14px 14px;
    gap: 12px;
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

  /* 移动端：隐藏音量滑块，保留静音按钮（避免窄屏误触） */
  .fpv-audio-volume {
    display: none;
  }

  .fpv-audio-btn {
    width: 40px;
    height: 40px;
  }

  .fpv-audio-btn--play {
    width: 46px;
    height: 46px;
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
