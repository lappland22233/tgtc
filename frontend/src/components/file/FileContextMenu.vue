<template>
  <teleport to="body">
    <transition name="ctx-fade">
      <div
        v-if="visible"
        ref="menuRef"
        class="file-ctx-menu"
        :style="{ top: pos.y + 'px', left: pos.x + 'px' }"
        role="menu"
        @click.stop
        @contextmenu.prevent.stop
      >
        <!-- 文件目标菜单 -->
        <template v-if="target?.kind === 'file'">
          <div class="ctx-header" :title="target.file.originalName">{{ target.file.originalName }}</div>

          <!-- 处理中：仅提示 -->
          <template v-if="target.file.status === 'processing'">
            <div class="ctx-item disabled"><t-icon name="refresh" class="ctx-icon spin" />文件处理中…</div>
          </template>

          <!-- 已删除：恢复 / 强制删除 -->
          <template v-else-if="target.file.isDeleted">
            <div
              class="ctx-item"
              :class="{ disabled: target.file.deletedByAdmin && !isAdmin }"
              role="menuitem"
              @click="!(target.file.deletedByAdmin && !isAdmin) && emitAction('restore')"
            >
              <t-icon name="rollback" class="ctx-icon" />恢复
            </div>
            <div v-if="isAdmin" class="ctx-item danger" role="menuitem" @click="emitAction('force-delete')">
              <t-icon name="delete" class="ctx-icon" />强制删除
            </div>
          </template>

          <!-- 正常文件：完整操作 -->
          <template v-else>
            <div class="ctx-item" role="menuitem" @click="emitAction('copy-link')">
              <t-icon name="link" class="ctx-icon" />复制链接
            </div>
            <div class="ctx-item" role="menuitem" @click="emitAction('download')">
              <t-icon name="download" class="ctx-icon" />下载
            </div>
            <div class="ctx-divider" />
            <div class="ctx-item" role="menuitem" @click="emitAction('rename')">
              <t-icon name="edit" class="ctx-icon" />重命名
            </div>
            <div class="ctx-item" role="menuitem" @click="emitAction('copy')">
              <t-icon name="copy" class="ctx-icon" />复制
            </div>
            <div class="ctx-item" role="menuitem" @click="emitAction('move')">
              <t-icon name="folder-move" class="ctx-icon" />移动到...
            </div>
            <div class="ctx-item" role="menuitem" @click="emitAction('tag')">
              <t-icon name="tag" class="ctx-icon" />标签
            </div>
            <div class="ctx-item" role="menuitem" @click="emitAction('share')">
              <t-icon name="share" class="ctx-icon" />分享
            </div>
            <div class="ctx-divider" />
            <!-- 访问控制（原表格内联列，现收纳进菜单） -->
            <div class="ctx-item" role="menuitem" @click="emitAction('toggle-access')">
              <t-icon :name="target.file.accessType === 'public' ? 'lock-off' : 'lock-on'" class="ctx-icon" />
              {{ target.file.accessType === 'public' ? '设为私有' : '设为公开' }}
            </div>
            <div class="ctx-item" role="menuitem" @click="emitAction('password')">
              <t-icon name="lock-on" class="ctx-icon" />
              {{ target.file.hasPassword ? '修改/移除密码' : '设置访问密码' }}
            </div>
            <div class="ctx-item" role="menuitem" @click="emitAction('access-count')">
              <t-icon name="view-list" class="ctx-icon" />访问次数限制…
            </div>
            <div class="ctx-item" role="menuitem" @click="emitAction('expires')">
              <t-icon name="time" class="ctx-icon" />限时访问…
            </div>
            <div class="ctx-divider" />
            <div class="ctx-item danger" role="menuitem" @click="emitAction('delete')">
              <t-icon name="delete" class="ctx-icon" />删除
            </div>
          </template>
        </template>

        <!-- 文件夹目标菜单 -->
        <template v-else-if="target?.kind === 'folder'">
          <div class="ctx-header" :title="target.folder.name">{{ target.folder.name }}</div>
          <div class="ctx-item" role="menuitem" @click="emitAction('open')">
            <t-icon name="folder-opened" class="ctx-icon" />打开
          </div>
          <div class="ctx-divider" />
          <div class="ctx-item" role="menuitem" @click="emitAction('rename')">
            <t-icon name="edit" class="ctx-icon" />重命名
          </div>
          <div class="ctx-item" role="menuitem" @click="emitAction('move')">
            <t-icon name="folder-move" class="ctx-icon" />移动到...
          </div>
          <div class="ctx-item" role="menuitem" @click="emitAction('share')">
            <t-icon name="share" class="ctx-icon" />分享
          </div>
          <div class="ctx-divider" />
          <div class="ctx-item danger" role="menuitem" @click="emitAction('delete')">
            <t-icon name="delete" class="ctx-icon" />删除
          </div>
        </template>

        <!-- 空白处菜单 -->
        <template v-else>
          <div class="ctx-item" role="menuitem" @click="emitAction('new-folder')">
            <t-icon name="folder-add" class="ctx-icon" />新建文件夹
          </div>
          <div class="ctx-item" role="menuitem" @click="emitAction('upload')">
            <t-icon name="upload" class="ctx-icon" />上传文件
          </div>
          <template v-if="clipboardCount > 0">
            <div class="ctx-divider" />
            <div class="ctx-item" role="menuitem" @click="emitAction('paste')">
              <t-icon name="paste" class="ctx-icon" />粘贴（{{ clipboardCount }} 个文件）
            </div>
          </template>
        </template>
      </div>
    </transition>
  </teleport>
</template>

<script setup lang="ts">
import { ref, reactive, watch, nextTick, onMounted, onUnmounted } from 'vue';
import type { FileItem } from '../../types/file';
import type { Folder } from '../../stores/folders';

/** 右键菜单目标：文件 / 文件夹 / 空白处 */
export type CtxTarget =
  | { kind: 'file'; file: FileItem }
  | { kind: 'folder'; folder: Folder }
  | { kind: 'blank' };

const props = defineProps<{
  visible: boolean;
  /** 期望的显示坐标（鼠标 / 触点位置） */
  x: number;
  y: number;
  target: CtxTarget | null;
  /** 剪贴板中已复制的文件数量（>0 时空白处菜单显示「粘贴」) */
  clipboardCount: number;
  /** 当前用户是否为管理员（用于显示「强制删除」） */
  isAdmin: boolean;
}>();

const emit = defineEmits<{
  'update:visible': [v: boolean];
  action: [action: string, target: CtxTarget | null];
}>();

const menuRef = ref<HTMLElement | null>(null);
/** 实际渲染坐标（经过视口边界修正，避免菜单溢出屏幕） */
const pos = reactive({ x: 0, y: 0 });

function emitAction(action: string) {
  emit('action', action, props.target);
  emit('update:visible', false);
}

/** 根据视口尺寸修正坐标，保证菜单完整可见 */
function adjustPosition() {
  const el = menuRef.value;
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const w = el?.offsetWidth || 200;
  const h = el?.offsetHeight || 300;
  let nx = props.x;
  let ny = props.y;
  if (nx + w > vw - 8) nx = Math.max(8, vw - w - 8);
  if (ny + h > vh - 8) ny = Math.max(8, vh - h - 8);
  pos.x = nx;
  pos.y = ny;
}

watch(() => props.visible, (v) => {
  if (v) {
    pos.x = props.x;
    pos.y = props.y;
    // 记录打开时的滚动基准（惰性，在首个滚动事件确定实际滚动容器）
    scrollAnchor = null;
    // 渲染后按实际尺寸修正一次，避免首次估算偏差
    nextTick(adjustPosition);
  }
});

// 点击菜单外部 / 按 Esc / 滚动时关闭
function onDocClick() {
  if (props.visible) emit('update:visible', false);
}
function onKeydown(e: KeyboardEvent) {
  if (e.key === 'Escape' && props.visible) emit('update:visible', false);
}

/** 菜单打开后的滚动基准位置；null 表示尚未在本次打开中记录 */
let scrollAnchor: number | null = null;

/** 读取滚动位置：优先事件目标容器的 scrollTop，回退到窗口滚动 */
function readScrollTop(e?: Event): number {
  const t = e?.target as HTMLElement | Document | null;
  if (t && t !== document && typeof (t as HTMLElement).scrollTop === 'number') {
    return (t as HTMLElement).scrollTop;
  }
  return window.scrollY || document.documentElement.scrollTop || 0;
}

// 滚动关闭：仅当滚动距离超过视口高度的 3% 时才隐藏，
// 避免轻微/误触滚动导致菜单刚弹出就闪退（需求：滚动超过 3% 屏高才隐藏）。
function onScroll(e: Event) {
  if (!props.visible) return;
  const cur = readScrollTop(e);
  if (scrollAnchor === null) {
    scrollAnchor = cur;
    return;
  }
  if (Math.abs(cur - scrollAnchor) > window.innerHeight * 0.03) {
    emit('update:visible', false);
  }
}

// 视口尺寸变化会使菜单定位失效，直接关闭
function onResize() {
  if (props.visible) emit('update:visible', false);
}

onMounted(() => {
  document.addEventListener('click', onDocClick);
  document.addEventListener('keydown', onKeydown);
  window.addEventListener('scroll', onScroll, true);
  window.addEventListener('resize', onResize);
});
onUnmounted(() => {
  document.removeEventListener('click', onDocClick);
  document.removeEventListener('keydown', onKeydown);
  window.removeEventListener('scroll', onScroll, true);
  window.removeEventListener('resize', onResize);
});
</script>

<style scoped>
.file-ctx-menu {
  position: fixed;
  z-index: 9999;
  min-width: 190px;
  max-width: 260px;
  padding: 6px 0;
  background: var(--color-bg-overlay);
  border: 1px solid var(--border-strong);
  border-radius: var(--radius-md);
  box-shadow: var(--shadow-lg), var(--shadow-glow);
  backdrop-filter: blur(12px);
  user-select: none;
}

.ctx-header {
  padding: 6px 14px 8px;
  font-size: 12px;
  color: var(--text-tertiary);
  border-bottom: 1px solid var(--border-default);
  margin-bottom: 4px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.ctx-item {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 14px;
  font-size: 13px;
  color: var(--text-primary);
  cursor: pointer;
  transition: background var(--duration-fast);
}
.ctx-item:hover {
  background: var(--color-accent-soft);
  color: var(--text-accent);
}
.ctx-item.danger {
  color: var(--color-danger);
}
.ctx-item.danger:hover {
  background: var(--color-danger-soft);
  color: var(--color-danger);
}
.ctx-item.disabled {
  color: var(--text-disabled);
  cursor: not-allowed;
  pointer-events: none;
}

.ctx-icon {
  font-size: 16px;
  flex-shrink: 0;
}
.ctx-icon.spin {
  animation: ctx-spin 1s linear infinite;
}
@keyframes ctx-spin {
  from { transform: rotate(0deg); }
  to { transform: rotate(360deg); }
}

.ctx-divider {
  height: 1px;
  background: var(--border-default);
  margin: 4px 0;
}

/* 进出场动画 */
.ctx-fade-enter-active,
.ctx-fade-leave-active {
  transition: opacity var(--duration-fast), transform var(--duration-fast);
  transform-origin: top left;
}
.ctx-fade-enter-from,
.ctx-fade-leave-to {
  opacity: 0;
  transform: scale(0.96);
}
</style>
