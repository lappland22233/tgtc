<template>
  <Teleport to="body">
    <Transition name="ctx-fade">
      <div
        v-if="visible"
        class="ctx-backdrop"
        :class="{ 'ctx-backdrop--mobile': mobile }"
        @click.self="emit('close')"
        @contextmenu.prevent="emit('close')"
      >
        <!-- 桌面端：跟随光标的浮动菜单 -->
        <div
          v-if="!mobile"
          ref="menuRef"
          class="ctx-menu"
          role="menu"
          :style="menuStyle"
          @click.stop
        >
          <template v-for="item in items" :key="item.key || 'sep'">
            <div v-if="item.divider" class="ctx-divider" />
            <button
              v-else
              type="button"
              class="ctx-item"
              :class="{ 'ctx-item--danger': item.danger, 'is-disabled': item.disabled }"
              role="menuitem"
              :disabled="item.disabled"
              @click="onSelect(item)"
            >
              <t-icon v-if="item.icon" :name="item.icon" class="ctx-item-icon" />
              <span class="ctx-item-label">{{ item.label }}</span>
              <span v-if="item.hint" class="ctx-item-hint">{{ item.hint }}</span>
            </button>
          </template>
        </div>

        <!-- 移动端：底部弹出的操作面板 -->
        <Transition name="ctx-sheet">
          <div v-if="mobile" class="ctx-sheet" role="menu" @click.stop>
            <div class="ctx-sheet-handle" />
            <div v-if="title" class="ctx-sheet-title">{{ title }}</div>
            <div class="ctx-sheet-list">
              <template v-for="item in items" :key="item.key || 'sep'">
                <div v-if="item.divider" class="ctx-divider" />
                <button
                  v-else
                  type="button"
                  class="ctx-item ctx-item--sheet"
                  :class="{ 'ctx-item--danger': item.danger, 'is-disabled': item.disabled }"
                  role="menuitem"
                  :disabled="item.disabled"
                  @click="onSelect(item)"
                >
                  <t-icon v-if="item.icon" :name="item.icon" class="ctx-item-icon" />
                  <span class="ctx-item-label">{{ item.label }}</span>
                </button>
              </template>
            </div>
            <button type="button" class="ctx-sheet-cancel" @click="emit('close')">取消</button>
          </div>
        </Transition>
      </div>
    </Transition>
  </Teleport>
</template>

<script setup lang="ts">
import { ref, computed, watch, nextTick, onMounted, onUnmounted } from 'vue';

/** 右键菜单项 */
export interface ContextMenuItem {
  /** 唯一标识（点击时回传）；divider 行可省略 */
  key?: string;
  label?: string;
  /** t-icon 图标名 */
  icon?: string;
  /** 危险操作（红色） */
  danger?: boolean;
  disabled?: boolean;
  /** 分隔线 */
  divider?: boolean;
  /** 右侧提示文本（如快捷键） */
  hint?: string;
}

const props = defineProps<{
  visible: boolean;
  /** 桌面端菜单左上角坐标 */
  x: number;
  y: number;
  /** 移动端模式：以底部面板呈现 */
  mobile: boolean;
  /** 移动端面板标题（通常为文件/文件夹名） */
  title?: string;
  items: ContextMenuItem[];
}>();

const emit = defineEmits<{
  close: [];
  select: [key: string];
}>();

const menuRef = ref<HTMLElement | null>(null);
const adjusted = ref({ x: 0, y: 0 });

/** 桌面端：渲染后测量菜单尺寸并向视口内收拢，避免越界 */
const menuStyle = computed(() => ({
  left: `${adjusted.value.x}px`,
  top: `${adjusted.value.y}px`,
}));

watch(() => [props.visible, props.x, props.y], async () => {
  if (!props.visible || props.mobile) return;
  adjusted.value = { x: props.x, y: props.y };
  await nextTick();
  const el = menuRef.value;
  if (!el) return;
  const rect = el.getBoundingClientRect();
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  let nx = props.x;
  let ny = props.y;
  if (nx + rect.width > vw - 8) nx = Math.max(8, vw - rect.width - 8);
  if (ny + rect.height > vh - 8) ny = Math.max(8, vh - rect.height - 8);
  adjusted.value = { x: nx, y: ny };
});

function onSelect(item: ContextMenuItem) {
  if (item.disabled || !item.key) return;
  emit('select', item.key);
}

function onKeydown(e: KeyboardEvent) {
  if (e.key === 'Escape' && props.visible) emit('close');
}

onMounted(() => {
  window.addEventListener('keydown', onKeydown);
  window.addEventListener('resize', () => props.visible && emit('close'));
  window.addEventListener('scroll', onScrollClose, true);
});

onUnmounted(() => {
  window.removeEventListener('keydown', onKeydown);
  window.removeEventListener('scroll', onScrollClose, true);
});

function onScrollClose() {
  if (props.visible) emit('close');
}
</script>

<style scoped>
.ctx-backdrop {
  position: fixed;
  inset: 0;
  z-index: 3000;
  background: transparent;
}

/* 移动端遮罩更明显，营造聚焦感 */
.ctx-backdrop--mobile {
  background: rgba(6, 9, 15, 0.45);
  backdrop-filter: blur(2px);
  display: flex;
  align-items: flex-end;
  justify-content: center;
}

/* ============ 桌面浮动菜单 ============ */
.ctx-menu {
  position: fixed;
  min-width: 200px;
  max-width: 260px;
  padding: 6px;
  background: var(--color-bg-overlay);
  border: 1px solid var(--border-strong);
  border-radius: var(--radius-md);
  box-shadow: var(--shadow-lg), var(--shadow-glow);
  backdrop-filter: blur(12px);
  animation: ctx-pop var(--duration-fast) var(--ease-out-back);
}

@keyframes ctx-pop {
  from { opacity: 0; transform: scale(0.96) translateY(-4px); }
  to { opacity: 1; transform: scale(1) translateY(0); }
}

.ctx-item {
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
  padding: 8px 10px;
  border: none;
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--text-primary);
  font-size: 13px;
  font-family: inherit;
  text-align: left;
  cursor: pointer;
  transition: background var(--duration-fast), color var(--duration-fast);
}

.ctx-item:hover:not(.is-disabled) {
  background: var(--color-accent-soft);
}

.ctx-item:active:not(.is-disabled) {
  background: var(--color-accent-glow);
}

.ctx-item.is-disabled {
  color: var(--text-disabled);
  cursor: not-allowed;
}

.ctx-item--danger {
  color: var(--color-danger);
}

.ctx-item--danger:hover:not(.is-disabled) {
  background: var(--color-danger-soft);
}

.ctx-item-icon {
  font-size: 16px;
  flex-shrink: 0;
  color: var(--text-secondary);
}

.ctx-item--danger .ctx-item-icon {
  color: var(--color-danger);
}

.ctx-item-label {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.ctx-item-hint {
  font-size: 11px;
  color: var(--text-tertiary);
  font-family: var(--font-mono);
}

.ctx-divider {
  height: 1px;
  margin: 6px 4px;
  background: var(--border-default);
}

/* ============ 移动端底部面板 ============ */
.ctx-sheet {
  width: 100%;
  max-width: 520px;
  max-height: 75vh;
  display: flex;
  flex-direction: column;
  background: var(--color-bg-overlay);
  border-radius: var(--radius-lg) var(--radius-lg) 0 0;
  border: 1px solid var(--border-default);
  border-bottom: none;
  padding: 8px 12px calc(12px + env(safe-area-inset-bottom, 0));
  overflow-y: auto;
}

.ctx-sheet-handle {
  width: 40px;
  height: 4px;
  border-radius: 2px;
  background: var(--border-strong);
  margin: 4px auto 10px;
  flex-shrink: 0;
}

.ctx-sheet-title {
  font-size: 13px;
  color: var(--text-secondary);
  text-align: center;
  padding: 0 8px 10px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  border-bottom: 1px solid var(--border-default);
  margin-bottom: 6px;
}

.ctx-item--sheet {
  padding: 13px 12px;
  font-size: 15px;
}

.ctx-sheet-cancel {
  margin-top: 8px;
  padding: 13px;
  border: none;
  border-radius: var(--radius-md);
  background: var(--color-bg-elevated);
  color: var(--text-secondary);
  font-size: 15px;
  font-family: inherit;
  cursor: pointer;
}

.ctx-sheet-cancel:active {
  background: var(--color-bg-surface);
}

/* ============ 过渡 ============ */
.ctx-fade-enter-active,
.ctx-fade-leave-active {
  transition: opacity var(--duration-fast);
}
.ctx-fade-enter-from,
.ctx-fade-leave-to {
  opacity: 0;
}

.ctx-sheet-enter-active {
  transition: transform var(--duration-normal) var(--ease-out-expo);
}
.ctx-sheet-leave-active {
  transition: transform var(--duration-fast) ease-in;
}
.ctx-sheet-enter-from,
.ctx-sheet-leave-to {
  transform: translateY(100%);
}
</style>
