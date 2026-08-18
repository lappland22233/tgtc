<template>
  <div class="folder-tree-container">
    <div class="tree-header">
      <span class="tree-title">文件夹</span>
      <t-button theme="primary" size="small" variant="text" @click="emit('create')">
        <template #icon><t-icon name="add" /></template>
        新建
      </t-button>
    </div>

    <t-loading v-if="folderStore.loading" size="small" />

    <t-tree
      v-else
      :data="treeData"
      :keys="{ value: 'id', label: 'name', children: 'children' }"
      :actived="folderStore.currentFolderId ? [folderStore.currentFolderId] : []"
      :expanded="expandedKeys"
      @expand="handleExpand"
      @active="handleSelect"
      hover
      transition
      activable
      line
    >
      <template #label="{ node }">
        <div
          class="tree-node-label"
          :class="{ active: node.data.id === folderStore.currentFolderId }"
          @contextmenu.prevent="onContextMenu($event, node.data)"
        >
          <t-icon name="folder" class="folder-icon" />
          <span class="node-name" :title="node.data.name">{{ node.data.name }}</span>
        </div>
      </template>
    </t-tree>

    <!-- 右键菜单 -->
    <div
      v-if="ctxMenu.visible"
      ref="ctxMenuRef"
      class="ctx-menu"
      :style="{ top: ctxMenu.y + 'px', left: ctxMenu.x + 'px' }"
      @click.stop=""
    >
      <div class="ctx-item" @click="onCtxAction('rename')">重命名</div>
      <div class="ctx-item" @click="onCtxAction('move')">移动到...</div>
      <div class="ctx-item danger" @click="onCtxAction('delete')">删除</div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted } from 'vue';
import MessagePlugin from '@/utils/message';
import { DialogPlugin } from 'tdesign-vue-next/es/dialog';
import { getErrorMessage } from '@/utils/error';
import { useFolderStore, type Folder } from '../../stores/folders';

const folderStore = useFolderStore();
const emit = defineEmits<{
  create: [];
  navigate: [folderId: string | null];
  rename: [folder: Folder];
  move: [folder: Folder];
}>();

const expandedKeys = ref<string[]>([]);

/** 根级文件夹 + 当前所在文件夹的所有祖先自动展开 */
const treeData = computed(() => folderStore.tree);

function handleExpand(value: string[]) {
  expandedKeys.value = value;
}

function handleSelect(value: string | string[]) {
  // active 事件返回数组；取消激活（空数组）或空值视为根目录
  const v = Array.isArray(value) ? value[0] : value;
  const folderId = !v ? null : v;
  emit('navigate', folderId);
}

// ---------- 右键菜单 ----------

const ctxMenuRef = ref<HTMLElement | null>(null);
const ctxMenu = ref({
  visible: false,
  x: 0,
  y: 0,
  folder: null as Folder | null,
});

/** 根据视口尺寸修正坐标，保证右键菜单完整可见（G13-09） */
function adjustCtxMenuPosition() {
  const el = ctxMenuRef.value;
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const w = el?.offsetWidth || 140;
  const h = el?.offsetHeight || 110;
  let nx = ctxMenu.value.x;
  let ny = ctxMenu.value.y;
  if (nx + w > vw - 8) nx = Math.max(8, vw - w - 8);
  if (ny + h > vh - 8) ny = Math.max(8, vh - h - 8);
  ctxMenu.value.x = nx;
  ctxMenu.value.y = ny;
}

function onContextMenu(e: MouseEvent, folder: Folder) {
  ctxMenu.value = {
    visible: true,
    x: e.clientX,
    y: e.clientY,
    folder,
  };
  // 渲染后按实际尺寸修正一次，避免超出视口右侧/底部
  requestAnimationFrame(adjustCtxMenuPosition);
}

function closeCtxMenu() {
  ctxMenu.value.visible = false;
}

/**
 * 判断当前浏览的文件夹是否位于以 rootId 为根的子树内（含 rootId 自身及其所有子孙）。
 * 删除祖先文件夹时，若当前在子孙目录中，也应回到根目录。
 */
function isCurrentInSubtree(rootId: string): boolean {
  const current = folderStore.currentFolderId;
  if (!current) return false;
  if (current === rootId) return true;
  // 沿 parentId 从当前文件夹逐级上溯祖先链，判断是否命中 rootId
  const parentMap = new Map<string, string>();
  const collectParents = (nodes: Folder[]) => {
    for (const node of nodes) {
      if (node.parentId != null) parentMap.set(node.id, node.parentId);
      if (node.children?.length) collectParents(node.children);
    }
  };
  collectParents(folderStore.tree);
  let cursor: string | undefined = current;
  const seen = new Set<string>();
  while (cursor && !seen.has(cursor)) {
    if (cursor === rootId) return true;
    seen.add(cursor);
    cursor = parentMap.get(cursor);
  }
  return false;
}

async function onCtxAction(action: 'rename' | 'move' | 'delete') {
  const folder = ctxMenu.value.folder;
  closeCtxMenu();
  if (!folder) return;

  if (action === 'rename') {
    emit('rename', folder);
  } else if (action === 'move') {
    emit('move', folder);
  } else if (action === 'delete') {
    const confirmDialog = DialogPlugin.confirm({
      header: '删除文件夹',
      // 注意：body 为字符串时 TDesign 按纯文本渲染（自动转义），folder.name 不会被解析为 HTML。
      // 切勿改为 innerHTML/VNode 拼接用户输入，否则会引入 XSS。
      body: `确定删除「${folder.name}」及其所有子文件夹和文件吗？此操作可在 7 天内撤销。`,
      theme: 'warning',
      confirmBtn: '删除',
      cancelBtn: '取消',
      onConfirm: async () => {
        try {
          await folderStore.deleteFolder(folder.id);
          MessagePlugin.success('文件夹已放入回收站，7 天后永久删除');
          // 若当前浏览的文件夹位于被删子树内（含其子孙），回到根目录（G13-10）
          if (isCurrentInSubtree(folder.id)) {
            emit('navigate', null);
          }
        } catch (err) {
          MessagePlugin.error(getErrorMessage(err) || '删除失败');
        }
        confirmDialog.destroy();
      },
      onClose: () => confirmDialog.destroy(),
    });
  }
}

// 点击其他位置 / 滚动 / 视口变化时关闭右键菜单
onMounted(() => {
  document.addEventListener('click', closeCtxMenu);
  window.addEventListener('scroll', closeCtxMenu, true);
  window.addEventListener('resize', closeCtxMenu);
});
onUnmounted(() => {
  document.removeEventListener('click', closeCtxMenu);
  window.removeEventListener('scroll', closeCtxMenu, true);
  window.removeEventListener('resize', closeCtxMenu);
});
</script>

<style scoped>
.folder-tree-container {
  height: 100%;
  display: flex;
  flex-direction: column;
  position: relative;
}

.tree-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 12px 16px 8px;
  border-bottom: 1px solid var(--td-border-level-1-color);
}

.tree-title {
  font-size: 14px;
  font-weight: 500;
  color: var(--td-text-color-primary);
}

.folder-tree-container :deep(.t-tree) {
  flex: 1;
  overflow-y: auto;
  padding: 4px 0;
}

.tree-node-label {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 4px 8px;
  border-radius: 4px;
  cursor: pointer;
  font-size: 13px;
}

.tree-node-label:hover {
  background: var(--td-bg-color-container-hover);
}

.tree-node-label.active {
  background: var(--td-brand-color-focus);
  color: var(--td-brand-color);
}

.folder-icon {
  color: var(--td-warning-color);
  flex-shrink: 0;
}

.node-name {
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* 右键菜单 */
.ctx-menu {
  position: fixed;
  z-index: 9999;
  background: var(--td-bg-color-container);
  border: 1px solid var(--td-border-level-2-color);
  border-radius: 6px;
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15);
  padding: 4px 0;
  min-width: 120px;
}

.ctx-item {
  padding: 8px 16px;
  cursor: pointer;
  font-size: 13px;
  color: var(--td-text-color-primary);
}

.ctx-item:hover {
  background: var(--td-bg-color-container-hover);
}

.ctx-item.danger {
  color: var(--td-error-color);
}
</style>
