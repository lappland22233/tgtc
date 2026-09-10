/**
 * 图片查看器（缩放 / 旋转 / 适应窗口 / 拖拽）。
 *
 * M6 拆分专项：从 FilePreviewDialog.vue 下沉为 composable（与既有的
 * usePreviewPoster / usePreviewText / usePlaylistControls 保持同一模式），
 * 使宿主只保留「取流 / 模板绑定 / 键盘快捷键转发」三类职责。
 *
 * 行为与拆分前完全一致，包括：
 * - 超大图（> 4096×4096 像素）先 createImageBitmap 异步降采样再渲染，避免同步解码阻塞主线程；
 * - 代次令牌（epoch）使切换文件后的旧探测/旧降采样任务失效；
 * - 降采样 ObjectURL 在切换与卸载时 revoke，避免内存泄漏；
 * - 适应窗口比例按舞台尺寸与旋转后的自然尺寸计算，平移量做边缘钳制。
 *
 * 不负责：媒体错误态（<img> 的 error 交由宿主 onMediaError 统一处理）、下载、播放列表。
 */
import { computed, ref } from 'vue';
import type { Ref } from 'vue';

/** 缩放上下限 */
export const IMAGE_SCALE_MIN = 0.1;
export const IMAGE_SCALE_MAX = 8;
/** 缩放档位步进比例（相对当前值，指数步进更符合视觉感受） */
const IMAGE_SCALE_STEP = 1.2;
/** 大图降采样触发阈值（像素数） */
const IMAGE_DOWNSAMPLE_PIXEL_THRESHOLD = 4096 * 4096;
/** 降采样后的最长边（像素） */
const IMAGE_DOWNSAMPLE_MAX_EDGE = 2048;

export interface ImageViewerOptions {
  /**
   * 会话代次：切换文件 / 重置时递增。
   * 用于让在途的尺寸探测与降采样任务失效，避免旧结果覆盖新图片。
   */
  epoch: Ref<number>;
}

export function useImageViewer(options: ImageViewerOptions) {
  const { epoch } = options;

  /** 图片舞台元素（模板 ref） */
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

  /** 释放降采样 ObjectURL（切换图片 / 重置 / 卸载时调用） */
  function releaseDownsampleUrl() {
    if (imageDownsampleUrl) {
      URL.revokeObjectURL(imageDownsampleUrl);
      imageDownsampleUrl = null;
    }
  }

  /**
   * 加载图片：先尝试异步解码并检测超大图，超阈值时用 createImageBitmap 降采样，
   * 避免超大图同步解码阻塞主线程导致白屏。切换/停止时通过代次令牌使旧任务失效。
   */
  async function setupImage(src: string | null) {
    // 释放上一张降采样资源
    releaseDownsampleUrl();
    imageDisplaySrc.value = null;
    imageDecoding.value = false;
    if (!src) return;
    const token = epoch.value;

    // 先异步探测图片尺寸（不阻塞主线程）
    const probe = await probeImageSize(src, token);
    if (token !== epoch.value) return;
    if (probe === null) {
      // 探测失败（非图片 / 网络失败）交由 <img> 的 error 事件处理
      imageDisplaySrc.value = src;
      return;
    }
    const pixels = probe.w * probe.h;
    if (pixels > IMAGE_DOWNSAMPLE_PIXEL_THRESHOLD) {
      // 超大图：createImageBitmap 降采样（限制最长边，保持宽高比）
      imageDecoding.value = true;
      try {
        const bitmap = await createImageBitmap(await fetch(src, { credentials: 'same-origin' }).then((r) => {
          if (!r.ok) throw new Error('load failed');
          return r.blob();
        }), {
          resizeWidth: Math.round(probe.w * (IMAGE_DOWNSAMPLE_MAX_EDGE / Math.max(probe.w, probe.h))),
          resizeHeight: Math.round(probe.h * (IMAGE_DOWNSAMPLE_MAX_EDGE / Math.max(probe.w, probe.h))),
          resizeQuality: 'high',
        });
        if (token !== epoch.value) { bitmap.close(); return; }
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
        if (token !== epoch.value) return;
        imageDownsampleUrl = URL.createObjectURL(blob);
        imageDisplaySrc.value = imageDownsampleUrl;
        // 用降采样尺寸作为自然尺寸
        imageNatural.value = { w: naturalW, h: naturalH };
        imageLoaded.value = true;
        resetImageView();
      } catch {
        if (token !== epoch.value) return;
        // 降采样失败回退原图（由 <img> 的 error/load 决定最终态）
        imageDisplaySrc.value = src;
      } finally {
        if (token === epoch.value) imageDecoding.value = false;
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
      if (token !== epoch.value) return null;
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

  /** 缩放到指定倍率（进入手动模式并钳制边界） */
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

  /** 切换文件时的完整复位（释放资源 + 清空渲染态 + 复位视图参数） */
  function resetImageViewerState() {
    releaseDownsampleUrl();
    imageDisplaySrc.value = null;
    imageDecoding.value = false;
    imageLoaded.value = false;
    imageNatural.value = { w: 0, h: 0 };
    imageScale.value = 1;
    imageRotation.value = 0;
    imageFit.value = 'contain';
    imageTranslate.value = { x: 0, y: 0 };
    imageDragging.value = false;
  }

  /** 组件卸载：释放降采样资源并清空渲染地址 */
  function disposeImageViewer() {
    releaseDownsampleUrl();
    imageDisplaySrc.value = null;
    imageDecoding.value = false;
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

  return {
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
    zoomImageTo,
    toggleImageFit,
    rotateImage,
    onImageLoad,
    onImageWheel,
    onImagePointerDown,
    onImagePointerMove,
    onImagePointerUp,
  };
}
