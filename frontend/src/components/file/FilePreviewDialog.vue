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
          <!-- 头部：文件名 + 播放列表导航 + 最小化/关闭（M6 拆出为展示组件，状态与快捷键仍由宿主持有） -->
          <PreviewHeader
            :name="snap.name"
            :has-playlist="hasPlaylist"
            :is-media-collection="isMediaCollection"
            :active-index="activeIndex"
            :playlist-length="playlist.length"
            :has-prev="hasPrev"
            :has-next="hasNext"
            :playlist-open="playlistOpen"
            :is-continuous-media="isContinuousMedia"
            :item-label="collectionItemLabel"
            @prev="playPrev"
            @next="playNext"
            @toggle-playlist="playlistOpen = !playlistOpen"
            @minimize="minimize"
            @close="fullStop"
          />

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
                :list-loop="listLoop"
                :shuffle="shuffle"
                :initial-time="mediaStore.pendingResume"
                :interactive="mediaStore.expanded"
                @update:end-behavior="setVideoEndBehavior"
                @update:list-loop="setListLoop"
                @update:shuffle="setShuffle"
                @video-ref="onCustomPlayerVideoRef"
                @request-play="activateVideo"
                @play="onVideoPlay"
                @pause="onVideoPaused"
                @ended="onVideoEnded"
                @seeking-change="onVideoSeekingChange"
                @error="onVideoError"
                @play-rejected="onVideoPlayRejected"
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

                <!-- 播放结束动作：与视频菜单保持同一语义 -->
                <button
                  type="button"
                  class="fpv-audio-rate"
                  :aria-label="listLoop ? '关闭列表循环' : '开启列表循环'"
                  :title="listLoop ? '列表循环：开' : '列表循环：关'"
                  @click="setListLoop(!listLoop)"
                >{{ listLoop ? '列表循环' : '顺序播放' }}</button>
                <button
                  type="button"
                  class="fpv-audio-rate"
                  :aria-label="shuffle ? '关闭乱序播放' : '开启乱序播放'"
                  :title="shuffle ? '乱序播放：开' : '乱序播放：关'"
                  @click="setShuffle(!shuffle)"
                >{{ shuffle ? '乱序' : '顺序' }}</button>

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
                :src="mediaStreamSrc || undefined"
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

            <!-- 文本：打开时 fetch 读取（M6 拆出为展示组件，加载/超限/失败三态由 props 驱动） -->
            <PreviewTextPanel
              v-else-if="snap.kind === 'text'"
              :loading="textLoading"
              :too-large="textTooLarge"
              :error-message="textError"
              :mime-type="snap.mimeType"
              :size="snap.size"
              :char-count="textCharCount"
              :content="textContent"
              @download="handleDownload"
            />

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

          <!-- 播放列表面板（M6 拆出为展示组件，展开态与列表数据仍由宿主持有） -->
          <PreviewPlaylistPanel
            ref="playlistPanelComp"
            v-model:open="playlistOpen"
            :items="playlist"
            :active-index="activeIndex"
            :kind="snap.kind"
            :title="collectionTitle"
            :item-label="collectionItemLabel"
            :thumb-context="currentMediaContext()"
            @switch="switchToTrack"
          />
        </div>
      </div>
  </teleport>
</template>

<script setup lang="ts">
import { ref, reactive, watch, nextTick, computed, onMounted, onBeforeUnmount } from 'vue';
import type { PreviewKind } from '../../utils/preview';
import {
  buildFileMediaTicketUrl,
  buildShareMediaTicketUrl,
  issueFileMediaTicket,
  issueShareMediaTicket,
} from '../../utils/preview';
import { triggerBrowserDownload } from '../../utils/download';
import { formatSizeCompact as formatSize } from '../../utils/format';
import CustomVideoPlayer from './CustomVideoPlayer.vue';
import PreviewHeader from './PreviewHeader.vue';
import PreviewPlaylistPanel from './PreviewPlaylistPanel.vue';
import PreviewTextPanel from './PreviewTextPanel.vue';
import {
  useMediaPlaybackStore,
  type MediaPlayerBridge,
  type MediaSession,
  type MediaSessionItem,
} from '../../stores/mediaPlayback';
import { usePreviewPoster } from '../../composables/usePreviewPoster';
import { usePreviewText } from '../../composables/usePreviewText';
import { usePlaylistControls } from '../../composables/usePlaylistControls';
import { useImageViewer } from '../../composables/useImageViewer';
import { useAudioPlayer } from '../../composables/useAudioPlayer';

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
/** 播放列表面板组件（M6 拆出后经 defineExpose 暴露真实 DOM，供「点击面板外收起」判断） */
const playlistPanelComp = ref<InstanceType<typeof PreviewPlaylistPanel> | null>(null);
const playlistPanelEl = computed<HTMLElement | null>(() => playlistPanelComp.value?.panelEl ?? null);

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
/** 原生音视频最终使用的短时票据 URL；不得复用登录 JWT 或分享访问 JWT。 */
const mediaStreamSrc = ref<string | null>(null);

const playlistControls = usePlaylistControls({
  mediaStore,
  snap,
  applyItem,
  activateVideo,
  getVideoRef: () => videoRef.value,
  getAudioRef: () => audioRef.value,
  getPlaylistPanelRef: () => playlistPanelEl.value,
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
  listLoop,
  shuffle,
  setListLoop,
  setShuffle,
  clearAutoNextTimer,
  switchToTrack,
  playPrev,
  playNext,
  onDialogPointerDown,
  onVideoPlay,
  onVideoEnded,
  onVideoPaused,
  onAudioEnded: handlePlaylistAudioEnded,
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
  if (item.kind === 'audio') void prepareNativeMediaSource(item.id, sessionEpoch.value);
}

/**
 * 在浏览器网络栈中签发一次短时票据，再交由原生媒体内核进行后续 Range 请求。
 * 票据绑定文件版本和访问上下文；系统媒体服务即使不携带 Cookie 也无法越权访问其他资源。
 */
async function prepareNativeMediaSource(fileId: string, epoch: number): Promise<string | null> {
  if (mediaStreamSrc.value) return mediaStreamSrc.value;
  const context = mediaStore.session?.context;
  if (!context) return null;
  try {
    const ticket = context.type === 'share'
      ? await issueShareMediaTicket(context.token, fileId)
      : await issueFileMediaTicket(fileId);
    if (epoch !== sessionEpoch.value || mediaStore.session?.item.id !== fileId) return null;
    mediaStreamSrc.value = context.type === 'share'
      ? buildShareMediaTicketUrl(ticket)
      : buildFileMediaTicketUrl(ticket);
    return mediaStreamSrc.value;
  } catch {
    if (epoch === sessionEpoch.value) {
      mediaError.value = true;
      mediaErrorText.value = '无法获取媒体播放凭据，请刷新后重试';
    }
    return null;
  }
}

// ============ 自定义音频控制 + 波形 ============
// M6 拆分：音频播放/进度/音量/倍速与 Web Audio 波形已下沉到 composables/useAudioPlayer.ts，
// 此处仅保留绑定（模板与快捷键）与生命周期转发；行为与拆分前一致。
const {
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
} = useAudioPlayer({
  mediaStore,
  audioEl: audioRef,
  onEnded: handlePlaylistAudioEnded,
  // 节流持久化与视频路径共用同一实现（函数声明提升，晚于此处定义也安全）
  persistProgress: throttlePersist,
});

/* 音频进度条 / 音量 / 倍速的全部交互实现已随 useAudioPlayer 下沉 */

function resetState() {
  sessionEpoch.value++;
  resetText();
  clearAutoNextTimer();
  resetPoster();
  teardownVideo();
  // 音频复位（停波形 + 卸载内核载荷 + 清零进度/拖动草稿）
  resetAudioState();
  // 图片查看状态复位（切换文件时避免上一张的缩放/旋转残留）
  resetImageViewerState();
  mediaError.value = false;
  mediaErrorText.value = null;
  mediaStreamSrc.value = null;
}

/** 收起为迷你播放器：音视频继续播放，其余类型直接停止 */
function minimize() {
  playlistOpen.value = false;
  mediaStore.minimize();
}

/** 真正停止：释放媒体资源并清空全局会话 */
function fullStop() {
  clearAutoNextTimer();
  teardownVideo();
  stopAudioPlayback();
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
    mediaStreamSrc.value = null;
    videoPlayerRef.value?.requestAutoplay?.();
    void activateVideo();
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
// M6 拆分：状态、异步探测/降采样与全部交互已下沉到 composables/useImageViewer.ts。
// 此处仅保留绑定（模板 ref / 计算属性）与键盘快捷键转发；行为与拆分前一致。
const {
  IMAGE_SCALE_MIN,
  IMAGE_SCALE_MAX,
  imageStageRef,
  imageScale,
  imageStyle,
  imageScaleText,
  imageDisplaySrc,
  imageDecoding,
  imageDragging,
  setupImage,
  resetImageView,
  resetImageViewerState,
  disposeImageViewer,
  zoomImageBy,
  toggleImageFit,
  rotateImage,
  onImageLoad,
  onImageWheel,
  onImagePointerDown,
  onImagePointerMove,
  onImagePointerUp,
} = useImageViewer({ epoch: sessionEpoch });

/* 图片视图的计算属性（适配比例 / 当前缩放 / transform / 文案）已随 useImageViewer 下沉 */

/* 图片加载链路（异步探测 → 超大图降采样 → 渲染）与 onImageLoad 已随 useImageViewer 下沉 */

/* 缩放 / 旋转 / 适应 / 边界钳制 / 滚轮与拖拽交互已随 useImageViewer 下沉 */

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
async function activateVideo() {
  if (videoSrc.value || !snap.src) return;
  videoPlayerRef.value?.requestAutoplay?.();
  const sourceUrl = await prepareNativeMediaSource(mediaStore.session?.item.id || '', sessionEpoch.value);
  if (sourceUrl) setupVideo(sourceUrl);
}

/** 激活视频预览：MSE 优先，不支持时原生回退 */
function setupVideo(sourceUrl = mediaStreamSrc.value) {
  const url = sourceUrl;
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
  videoSrc.value = mediaStreamSrc.value;
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

function onVideoPlayRejected(reason: string) {
  mediaError.value = true;
  mediaErrorText.value = reason === 'NotAllowedError'
    ? '浏览器阻止了自动播放，请再次点击播放按钮'
    : '无法开始播放，请重试或检查媒体格式';
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
    resumeAudioWaveformLoop();
  } else {
    pauseAudioWaveformLoop();
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
  clearAutoNextTimer();
  window.removeEventListener('keydown', onKeydown);
  document.removeEventListener('visibilitychange', onVisibility);
  abortText();
  clearPosterRetryTimer();
  releasePosterResource();
  teardownVideo();
  disposeAudioPlayer();
  disposeImageViewer();
  mediaStore.unregisterBridge();
});

/** 底部下载：优先使用会话中的 downloadUrl，否则用预览地址兜底 */
function handleDownload() {
  const url = snap.downloadUrl || snap.src;
  if (!url) return;
  triggerBrowserDownload(url, snap.name || undefined);
}

// 文件大小格式化已上移到 utils/format.ts（formatSizeCompact），
// 与拆分出的 PreviewPlaylistPanel 共用同一实现，避免两处精度策略漂移。
</script>

<!-- 跨拆出组件的共享规则（.fpv-state / .fpv-btn），见文件头注释 -->
<style scoped src="./preview-shared.css"></style>

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

/* 头部（.fpv-header / .fpv-name / .fpv-close）样式已迁移至 PreviewHeader.vue（M6 拆分） */

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

/* 文本面板样式已随组件迁移至 PreviewTextPanel.vue；
   .fpv-state / .fpv-btn 为跨组件共享规则，见 preview-shared.css。 */

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

/* 头部右侧操作区与导航按钮样式已迁移至 PreviewHeader.vue（M6 拆分）；
   播放列表面板样式已迁移至 PreviewPlaylistPanel.vue。 */

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

  .fpv-footer {
    padding: 8px 10px;
  }

  /* 播放列表面板的窄屏覆盖已随组件迁移至 PreviewPlaylistPanel.vue */
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

  /* 头部同一压缩规则在 PreviewHeader.vue 内（scoped 样式不跨组件，需各自声明） */
  .fpv-footer {
    padding-block: 6px;
  }

  .fpv-body {
    padding: 6px;
  }
}

@media (prefers-reduced-motion: reduce) {
  .fpv-audio-wave--playing span {
    animation: none;
  }
}
</style>
