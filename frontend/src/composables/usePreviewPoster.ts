/**
 * 视频封面与冷资源加载状态 composable
 *
 * 职责：
 * - 视频封面 Object URL（封面只请求一次，再由 video poster 复用本地 Blob）。
 * - 低清封面一次性升级高清（共享 Blob 缓存 + in-flight 合并）。
 * - 冷资源加载模式：文件尚未缓存时钳制 seek，避免动态分段请求。
 * - 封面在共享 Blob 缓存中的引用管理（posterResourceKey 配对 release）。
 *
 * 依赖注入：
 * - mediaStore：访问当前会话上下文与内容版本（缩略图缓存键）。
 * - snap：只读 kind，判定当前是否为视频。
 * - epoch：会话代次 ref，检测切换后冷状态查询是否失效。
 */
import { ref } from 'vue';
import type { Ref } from 'vue';
import type { PreviewKind } from '../utils/preview';
import {
  buildShareThumbnailUrl,
  buildShareHdThumbnailUrl,
  fetchFileCacheStatus,
  fetchShareCacheStatus,
} from '../utils/preview';
import {
  getThumbnailUrl,
  getHdThumbnailUrl,
  getThumbnailResource,
  buildThumbResourceKey,
  releaseThumbnailResource,
} from '../utils/thumbnailCache';
import type { useMediaPlaybackStore } from '../stores/mediaPlayback';

/** 高清封面升级阈值（低于此分辨率的封面一次性升级高清） */
const HD_COVER_MIN_WIDTH = 640;
const HD_COVER_MIN_HEIGHT = 360;

/** 宿主快照的最小形状（本模块只关心 kind） */
export interface PreviewSnapLike {
  kind: PreviewKind | null;
}

export interface PreviewPosterOptions {
  mediaStore: ReturnType<typeof useMediaPlaybackStore>;
  snap: PreviewSnapLike;
  /** 会话代次 ref（切换 / 重置时递增），用于检测视频切换后冷状态查询是否失效 */
  epoch: Ref<number>;
}

export function usePreviewPoster(options: PreviewPosterOptions) {
  const { mediaStore, snap, epoch } = options;

  /** 视频封面 Object URL（封面只请求一次，再由 video poster 复用本地 Blob） */
  const posterUrl = ref<string | null>(null);
  /** 当前封面所属文件 ID（播放列表切换时更新） */
  const currentPosterFileId = ref('');
  /** 当前封面在共享 Blob 缓存中的键（切换 / 关闭时 release 引用） */
  let posterResourceKey: string | null = null;
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

  /** Object URL 由共享 Blob 缓存统一管理生命周期（淘汰时 revoke），这里只更新引用并配对 release。 */
  function setPosterObjectUrl(url: string | null) {
    posterUrl.value = url;
  }

  /** 释放当前封面在共享缓存中的引用（不影响仍被其他组件使用的 Blob） */
  function releasePosterResource() {
    if (posterResourceKey) {
      releaseThumbnailResource(posterResourceKey);
      posterResourceKey = null;
    }
  }

  /** 当前媒体会话的访问上下文标识（与 ThumbnailImg 的 context prop 对齐） */
  function currentMediaContext(): string {
    const ctx = mediaStore.session?.context;
    return ctx?.type === 'share' ? `s:${ctx.token}` : `u:${ctx?.userId ?? ''}`;
  }

  /** 当前封面任务是否仍属于同一视频。 */
  function isCurrentPosterTask(fid: string, token: number): boolean {
    return snap.kind === 'video'
      && currentPosterFileId.value === fid
      && posterLoadToken === token;
  }

  /** 查询当前视频是否为冷资源（尚无正式缓存），决定是否开启 seek 钳制 */
  async function checkColdStatus() {
    const session = mediaStore.session;
    const fid = currentPosterFileId.value;
    const stateToken = epoch.value;
    if (!session || !fid) return;
    const ctx = session.context;
    const status = ctx.type === 'share'
      ? await fetchShareCacheStatus(ctx.token, fid)
      : await fetchFileCacheStatus(fid);
    if (snap.kind !== 'video' || currentPosterFileId.value !== fid || epoch.value !== stateToken) return;
    // cold/unknown 均钳制 seek；仅 cached 允许 Range 跳转
    coldLoad.value = status !== 'cached';
  }

  /**
   * 加载视频封面：标准封面优先复用共享 Blob 缓存（列表缩略图已下载的字节直接复用），
   * 检测低分辨率后一次性升级高清封面；两者都走同一缓存层的 in-flight 合并。
   */
  async function loadPoster() {
    const session = mediaStore.session;
    const fid = currentPosterFileId.value;
    const token = ++posterLoadToken;
    if (!session || !fid || snap.kind !== 'video') return;

    const ctx = session.context;
    const context = currentMediaContext();
    const version = session.item.contentVersion;

    // 标准封面：与列表 ThumbnailImg 共用缓存键（u/s 上下文 + fileId + 版本 + thumb 规格）
    const standardUrl = ctx.type === 'share'
      ? buildShareThumbnailUrl(ctx.token, fid)
      : await getThumbnailUrl(fid, 'video/mp4');
    if (!standardUrl || !isCurrentPosterTask(fid, token)) return;

    const standardKey = buildThumbResourceKey({ context, fileId: fid, version, hd: false });
    const standard = await getThumbnailResource({
      context,
      fileId: fid,
      version,
      hd: false,
      url: standardUrl,
    });
    if (!isCurrentPosterTask(fid, token)) {
      if (standard) releaseThumbnailResource(standardKey);
      return;
    }
    if (!standard) {
      releasePosterResource();
      setPosterObjectUrl(null);
      return;
    }
    releasePosterResource();
    setPosterObjectUrl(standard.objectUrl);
    posterResourceKey = standardKey;

    if (standard.width >= HD_COVER_MIN_WIDTH && standard.height >= HD_COVER_MIN_HEIGHT) return;
    if (hdCoverAttempted) return;

    hdCoverAttempted = true;
    const hdUrl = ctx.type === 'share'
      ? buildShareHdThumbnailUrl(ctx.token, fid)
      : await getHdThumbnailUrl(fid, 'video/mp4');
    if (!hdUrl || !isCurrentPosterTask(fid, token)) return;

    const hdKey = buildThumbResourceKey({ context, fileId: fid, version, hd: true });
    const hd = await getThumbnailResource({
      context,
      fileId: fid,
      version,
      hd: true,
      url: hdUrl,
    });
    if (!isCurrentPosterTask(fid, token)) {
      if (hd) releaseThumbnailResource(hdKey);
      return;
    }
    if (hd) {
      releasePosterResource();
      setPosterObjectUrl(hd.objectUrl);
      posterResourceKey = hdKey;
    }
  }

  /** 冷资源缓存完成后补一次封面加载（此时普通/高清封面通常已可生成） */
  function retryPosterAfterCache() {
    if (posterRetryCount >= 1) return;
    posterRetryCount++;
    hdCoverAttempted = false;
    clearPosterRetryTimer();
    posterRetryTimer = setTimeout(() => {
      posterRetryTimer = null;
      if (!mediaStore.session) return;
      void loadPoster();
    }, 800);
  }

  /** 切到视频项时启动封面加载与冷状态查询（宿主 applyItem 调用） */
  function startPosterForFile(fileId: string) {
    currentPosterFileId.value = fileId;
    setPosterObjectUrl(null);
    hdCoverAttempted = false;
    posterRetryCount = 0;
    coldLoad.value = false;
    void checkColdStatus();
    void loadPoster();
  }

  /** 会话切换 / 重置：清空封面与冷资源状态，避免下一文件残留 */
  function resetPoster() {
    clearPosterRetryTimer();
    posterLoadToken++;
    releasePosterResource();
    setPosterObjectUrl(null);
    currentPosterFileId.value = '';
    coldLoad.value = false;
    hdCoverAttempted = false;
    posterRetryCount = 0;
  }

  return {
    posterUrl,
    coldLoad,
    currentMediaContext,
    clearPosterRetryTimer,
    releasePosterResource,
    checkColdStatus,
    loadPoster,
    retryPosterAfterCache,
    startPosterForFile,
    resetPoster,
  };
}
