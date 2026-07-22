import { reactive, onUnmounted, type Ref } from 'vue';

/**
 * 文件拖拽移动（桌面端）。
 *
 * 交互：在文件行上按住鼠标左键约 220ms（长按）进入拖拽态，随后移动鼠标即可
 * 拖动一个跟随光标的"幽灵"指示器；悬停到文件夹行时高亮该文件夹，松开鼠标
 * 即把文件移动到该文件夹。
 *
 * 设计要点：
 * - 采用自定义 mouse 事件实现（而非 HTML5 DnD），与页面既有的"拖拽上传"
 *   （基于 dataTransfer.files 的原生 DnD）完全隔离，互不干扰；
 * - 长按阈值内若位移超过 6px 则视为普通点击/选择，不触发拖拽，避免误触；
 * - 拖拽目标通过 elementFromPoint + [data-drop-folder] 识别，文件夹行只需
 *   打上 data-drop-folder="<folderId>"（"root" 代表根目录）即可作为投放区。
 */

export interface DragMoveState {
  /** 是否已长按激活、处于可拖拽/拖拽中 */
  active: boolean;
  /** 是否正在拖动（幽灵可见） */
  dragging: boolean;
  /** 被拖拽文件数量 */
  count: number;
  /** 首个被拖拽文件名（幽灵上展示） */
  firstName: string;
  /** 幽灵指示器坐标 */
  ghostX: number;
  ghostY: number;
  /** 当前悬停的目标文件夹 ID（"root" 表示根目录），用于高亮 */
  overFolderId: string | null;
}

const LONG_PRESS_MS = 220;
const MOVE_SLOP_PX = 6;

/** 命中这些交互元素时不启动拖拽，保证按钮/复选框可正常点击 */
const INTERACTIVE_SELECTOR = 'button, input, select, textarea, a, label, .t-checkbox, .t-select, .t-input, .t-icon, .t-tag, .os-tag-click';

export function useDragMove(opts: {
  isMobile: Ref<boolean>;
  onMove: (fileIds: string[], folderId: string | null) => void | Promise<void>;
}) {
  const state = reactive<DragMoveState>({
    active: false,
    dragging: false,
    count: 0,
    firstName: '',
    ghostX: 0,
    ghostY: 0,
    overFolderId: null,
  });

  let startX = 0;
  let startY = 0;
  let pressTimer: ReturnType<typeof setTimeout> | null = null;
  let pendingIds: string[] = [];
  let bound = false;

  function cleanup() {
    if (pressTimer) { clearTimeout(pressTimer); pressTimer = null; }
    if (bound) {
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('mouseup', onMouseUp);
      bound = false;
    }
    state.active = false;
    state.dragging = false;
    state.overFolderId = null;
    pendingIds = [];
    document.body.classList.remove('is-file-dragging');
  }

  function onMouseMove(e: MouseEvent) {
    // 尚未激活：位移超过阈值则判定为普通点击，取消拖拽
    if (!state.active) {
      if (Math.hypot(e.clientX - startX, e.clientY - startY) > MOVE_SLOP_PX) {
        cleanup();
      }
      return;
    }
    // 已激活：进入/继续拖动
    if (!state.dragging) state.dragging = true;
    state.ghostX = e.clientX;
    state.ghostY = e.clientY;
    state.overFolderId = detectFolder(e.clientX, e.clientY);
    // 阻止拖拽过程中的文本选中
    e.preventDefault();
  }

  function onMouseUp(e: MouseEvent) {
    const folderId = state.active && state.dragging ? detectFolder(e.clientX, e.clientY) : null;
    const ids = [...pendingIds];
    const shouldMove = state.dragging && folderId !== null && ids.length > 0;
    cleanup();
    if (shouldMove) {
      void opts.onMove(ids, folderId === 'root' ? null : folderId);
    }
  }

  /** 通过坐标命中文件夹投放区，返回其 data-drop-folder 值（未命中为 null） */
  function detectFolder(x: number, y: number): string | null {
    const el = document.elementFromPoint(x, y);
    const target = el?.closest?.('[data-drop-folder]') as HTMLElement | null;
    return target ? target.getAttribute('data-drop-folder') : null;
  }

  /**
   * 在文件行 mousedown 时调用。fileIds 为本次拖拽的文件 ID 集合
   * （若该行已被勾选则为全部勾选文件，否则仅为该行文件）。
   */
  function startPotentialDrag(e: MouseEvent, fileIds: string[], firstName: string) {
    if (opts.isMobile.value) return;          // 移动端走长按菜单，不启用拖拽
    if (e.button !== 0) return;                // 仅左键
    if (fileIds.length === 0) return;
    const target = e.target as HTMLElement | null;
    if (target?.closest?.(INTERACTIVE_SELECTOR)) return; // 点在按钮/复选框等交互元素上

    startX = e.clientX;
    startY = e.clientY;
    pendingIds = [...fileIds];
    state.count = fileIds.length;
    state.firstName = firstName;
    state.ghostX = e.clientX;
    state.ghostY = e.clientY;

    // 长按计时：达到阈值且位移未超阈值时激活拖拽
    pressTimer = setTimeout(() => {
      state.active = true;
      document.body.classList.add('is-file-dragging');
    }, LONG_PRESS_MS);

    if (!bound) {
      window.addEventListener('mousemove', onMouseMove);
      window.addEventListener('mouseup', onMouseUp);
      bound = true;
    }
  }

  onUnmounted(cleanup);

  return { state, startPotentialDrag };
}
