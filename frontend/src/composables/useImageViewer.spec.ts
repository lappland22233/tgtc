// @vitest-environment jsdom
import { ref } from 'vue';
import { beforeEach, describe, expect, it } from 'vitest';
import { IMAGE_SCALE_MAX, IMAGE_SCALE_MIN, useImageViewer } from './useImageViewer';

/**
 * M6 拆分回归：图片查看器从 FilePreviewDialog.vue 下沉为 composable 后，
 * 缩放/适应/旋转/拖拽边界等纯视图逻辑必须与拆分前一致。
 */

/** 舞台元素只需提供尺寸（composable 只读 clientWidth/Height）。 */
function fakeStage(width: number, height: number): HTMLElement {
  return { clientWidth: width, clientHeight: height } as unknown as HTMLElement;
}

function pointerEvent(x: number, y: number): PointerEvent {
  // 真实事件必定带 currentTarget（触发元素）；补一个带 setPointerCapture 的替身，
  // 与拆分前的实现假设一致（该调用为可选链，元素能力不足时静默跳过）。
  const target = { setPointerCapture: () => undefined } as unknown as EventTarget;
  return { clientX: x, clientY: y, pointerId: 1, currentTarget: target } as unknown as PointerEvent;
}

describe('useImageViewer（M6 拆分契约）', () => {
  let viewer: ReturnType<typeof useImageViewer>;

  beforeEach(() => {
    viewer = useImageViewer({ epoch: ref(0) });
  });

  /** 模拟图片加载完成：设置自然尺寸（与 <img> load 事件一致） */
  function loadImage(naturalWidth: number, naturalHeight: number) {
    viewer.imageStageRef.value = fakeStage(1000, 500);
    viewer.onImageLoad({ target: { naturalWidth, naturalHeight } } as unknown as Event);
  }

  it('初始为适应窗口模式，文案为「适应」', () => {
    expect(viewer.imageScaleText.value).toBe('适应');
    expect(viewer.imageStyle.value.transform).toContain('scale(1)');
  });

  it('图片加载后计算适应比例（不放大超过 100%）', () => {
    loadImage(2000, 1000);

    // min(1000/2000, 500/1000, 1) = 0.5
    expect(viewer.imageStyle.value.transform).toContain('scale(0.5)');
    expect(viewer.imageStyle.value.transform).toContain('rotate(0deg)');
  });

  it('小图保持 100%，不因适应窗口被放大', () => {
    loadImage(200, 100);

    expect(viewer.imageStyle.value.transform).toContain('scale(1)');
  });

  it('适应 / 实际尺寸切换：进入 manual 为 100%，返回 contain 时归零平移', () => {
    loadImage(2000, 1000);

    viewer.toggleImageFit();
    expect(viewer.imageScaleText.value).toBe('100%');
    expect(viewer.imageStyle.value.transform).toContain('scale(1)');

    viewer.toggleImageFit();
    expect(viewer.imageScaleText.value).toBe('适应');
    expect(viewer.imageStyle.value.transform).toContain('translate(0px, 0px)');
  });

  it('适应模式下相对缩放以适应比例为基准', () => {
    loadImage(2000, 1000);

    viewer.zoomImageBy(1);

    // 0.5 * 1.2 = 0.6
    expect(viewer.imageScaleText.value).toBe('60%');
  });

  it('缩放被钳制在 [IMAGE_SCALE_MIN, IMAGE_SCALE_MAX]', () => {
    loadImage(2000, 1000);
    viewer.toggleImageFit();

    for (let i = 0; i < 40; i++) viewer.zoomImageBy(1);
    expect(viewer.imageScaleText.value).toBe(`${IMAGE_SCALE_MAX * 100}%`);

    for (let i = 0; i < 80; i++) viewer.zoomImageBy(-1);
    expect(viewer.imageScaleText.value).toBe(`${Math.round(IMAGE_SCALE_MIN * 100)}%`);
  });

  it('旋转 90° 后交换宽高重算适应比例，并归零平移', () => {
    loadImage(2000, 1000);

    viewer.rotateImage();

    // 旋转后 iw=1000, ih=2000 → min(1, 0.25, 1) = 0.25
    expect(viewer.imageStyle.value.transform).toContain('rotate(90deg)');
    expect(viewer.imageStyle.value.transform).toContain('scale(0.25)');
    expect(viewer.imageStyle.value.transform).toContain('translate(0px, 0px)');

    viewer.rotateImage();
    viewer.rotateImage();
    viewer.rotateImage();
    expect(viewer.imageStyle.value.transform).toContain('rotate(0deg)');
  });

  it('Ctrl/⌘ + 滚轮缩放；普通滚动不拦截', () => {
    loadImage(2000, 1000);
    let prevented = false;
    const plain = { ctrlKey: false, metaKey: false, deltaY: -100, preventDefault: () => { prevented = true; } } as unknown as WheelEvent;

    viewer.onImageWheel(plain);
    expect(prevented).toBe(false);
    expect(viewer.imageScaleText.value).toBe('适应');

    const ctrl = { ctrlKey: true, metaKey: false, deltaY: -100, preventDefault: () => { prevented = true; } } as unknown as WheelEvent;
    viewer.onImageWheel(ctrl);
    expect(prevented).toBe(true);
    expect(viewer.imageScaleText.value).toBe('60%');

    const zoomOut = { ctrlKey: true, metaKey: false, deltaY: 100, preventDefault: () => undefined } as unknown as WheelEvent;
    viewer.onImageWheel(zoomOut);
    expect(viewer.imageScaleText.value).toBe('50%');
  });

  it('适应模式下（未放大）不启动拖拽', () => {
    loadImage(2000, 1000);

    viewer.onImagePointerDown(pointerEvent(100, 100));
    expect(viewer.imageDragging.value).toBe(false);
  });

  it('放大后拖拽平移，并在松开时做边界钳制', () => {
    loadImage(2000, 1000);
    viewer.zoomImageBy(1); // 0.6 → 图片 1200×600，舞台 1000×500 → maxX=100, maxY=50

    viewer.onImagePointerDown(pointerEvent(100, 100));
    expect(viewer.imageDragging.value).toBe(true);

    viewer.onImagePointerMove(pointerEvent(400, 400));
    // 未松手期间不做钳制
    expect(viewer.imageStyle.value.transform).toContain('translate(300px, 300px)');

    viewer.onImagePointerUp();
    expect(viewer.imageDragging.value).toBe(false);
    // 钳制到边界内
    expect(viewer.imageStyle.value.transform).toContain('translate(100px, 50px)');
  });

  it('切换文件时 resetImageViewerState 清空渲染态并复位视图参数', () => {
    loadImage(2000, 1000);
    viewer.zoomImageBy(1);
    viewer.imageDisplaySrc.value = '/api/files/1/stream';

    viewer.resetImageViewerState();

    expect(viewer.imageDisplaySrc.value).toBeNull();
    expect(viewer.imageDecoding.value).toBe(false);
    expect(viewer.imageDragging.value).toBe(false);
    expect(viewer.imageScaleText.value).toBe('适应');
    expect(viewer.imageStyle.value.transform).toContain('scale(1)');
  });

  it('卸载时 disposeImageViewer 清空渲染地址', () => {
    viewer.imageDisplaySrc.value = '/api/files/1/stream';
    viewer.imageDecoding.value = true;

    viewer.disposeImageViewer();

    expect(viewer.imageDisplaySrc.value).toBeNull();
    expect(viewer.imageDecoding.value).toBe(false);
  });
});
