<template>
  <nav class="workspace-directory" aria-label="文件夹">
    <div class="directory-heading">
      <h2>文件夹</h2>
      <button v-if="dismissible" type="button" class="directory-icon" aria-label="关闭目录" @click="emit('close')">
        <t-icon name="close" aria-hidden="true" />
      </button>
    </div>
    <button
      type="button"
      class="directory-root directory-link"
      :aria-current="currentFolderId === null ? 'location' : undefined"
      :class="{ 'is-drop-target': dragOverFolderId === rootDropTarget }"
      @click="emit('navigate', null)"
      @dragenter="emit('folder-drag-over', $event, rootDropTarget)"
      @dragover="emit('folder-drag-over', $event, rootDropTarget)"
      @dragleave="emit('folder-drag-leave', $event, rootDropTarget)"
      @drop="emit('drop-on-folder', $event, rootDropTarget)"
    >
      <t-icon name="home" aria-hidden="true" />
      全部文件
    </button>
    <div v-if="loadError && !loading" class="directory-feedback">
      <p>目录加载失败</p>
      <button type="button" @click="emit('retry')">重试</button>
    </div>
    <div v-else-if="loading && !folders.length" class="directory-feedback" role="status">正在加载目录…</div>
    <ul v-else-if="visibleFolders.length" class="directory-list">
      <li
        v-for="{ folder, depth, hasChildren } in visibleFolders"
        :key="folder.id"
        class="directory-row"
        :class="{ 'is-current': currentFolderId === folder.id, 'is-drop-target': dragOverFolderId === folder.id }"
        :style="{ '--directory-depth': Math.min(depth, 5) }"
        @dragenter="emit('folder-drag-over', $event, folder.id)"
        @dragover="emit('folder-drag-over', $event, folder.id)"
        @dragleave="emit('folder-drag-leave', $event, folder.id)"
        @drop="emit('drop-on-folder', $event, folder.id)"
      >
        <button
          v-if="hasChildren"
          type="button"
          class="directory-icon directory-expander"
          :aria-expanded="expanded.has(folder.id)"
          :aria-label="(expanded.has(folder.id) ? '折叠 ' : '展开 ') + folder.name"
          @click="toggle(folder.id)"
        >
          <t-icon :name="expanded.has(folder.id) ? 'chevron-down' : 'chevron-right'" aria-hidden="true" />
        </button>
        <button
          type="button"
          class="directory-link"
          :aria-current="currentFolderId === folder.id ? 'location' : undefined"
          :title="folder.name"
          @click="emit('navigate', folder.id)"
          @contextmenu="openContextMenu($event, folder)"
        >
          <t-icon :name="expanded.has(folder.id) || currentFolderId === folder.id ? 'folder-open' : 'folder'" aria-hidden="true" />
          <span>{{ folder.name }}</span>
        </button>
      </li>
    </ul>
  </nav>
</template>

<script setup lang="ts">
import { computed, reactive, watch } from 'vue';
import type { Folder } from '@/stores/folders';

const props = defineProps<{
  folders: Folder[];
  breadcrumb: Folder[];
  currentFolderId: string | null;
  dragOverFolderId: string | null;
  rootDropTarget: string;
  loading: boolean;
  loadError: boolean;
  dismissible: boolean;
}>();

const emit = defineEmits<{
  navigate: [folderId: string | null];
  close: [];
  retry: [];
  'folder-ctxmenu': [event: MouseEvent, folder: Folder];
  'folder-drag-over': [event: DragEvent, target: string];
  'folder-drag-leave': [event: DragEvent, target: string];
  'drop-on-folder': [event: DragEvent, target: string];
}>();

const expanded = reactive(new Set<string>());
watch(() => props.breadcrumb.map(({ id }) => id), (path) => {
  for (const id of path) expanded.add(id);
}, { immediate: true });

const visibleFolders = computed(() => {
  const result: { folder: Folder; depth: number; hasChildren: boolean }[] = [];
  const stack = props.folders.map((folder) => ({ folder, depth: 0 })).reverse();
  while (stack.length) {
    const { folder, depth } = stack.pop()!;
    if (folder.isDeleted) continue;
    const children = folder.children?.filter((child) => !child.isDeleted) ?? [];
    result.push({ folder, depth, hasChildren: children.length > 0 });
    if (expanded.has(folder.id)) {
      for (let i = children.length - 1; i >= 0; i--) stack.push({ folder: children[i], depth: depth + 1 });
    }
  }
  return result;
});

function toggle(id: string) {
  if (expanded.has(id)) expanded.delete(id);
  else expanded.add(id);
}

function openContextMenu(event: MouseEvent, folder: Folder) {
  if (props.dismissible) return;
  event.preventDefault();
  event.stopPropagation();
  emit('folder-ctxmenu', event, folder);
}
</script>

<style scoped>
.workspace-directory {
  min-width: 0;
  padding: 18px 10px;
  background: var(--workspace-canvas);
  color: var(--workspace-text);
}

.directory-heading {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding-inline: 8px;
  margin-bottom: 8px;
}

.directory-heading h2 { color: var(--workspace-muted); font-size: 12px; font-weight: 600; }
.directory-list { padding: 0; margin: 0; list-style: none; }

.directory-row {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr);
  min-width: 0;
  padding-inline-start: calc(7px * var(--directory-depth));
  border-radius: var(--radius-md);
}

.directory-link,
.directory-icon,
.directory-feedback button {
  border: 0;
  background: transparent;
  color: inherit;
  cursor: pointer;
}

.directory-link,
.directory-icon {
  display: flex;
  align-items: center;
  gap: 6px;
  min-height: 38px;
  border-radius: var(--radius-md);
}

.directory-icon { justify-content: center; font-size: 15px; width: 26px; padding: 0; }
.directory-heading .directory-icon { width: 38px; }

.directory-link {
  grid-column: 2;
  width: 100%;
  min-width: 0;
  padding: 4px 8px;
  font: 500 13px/1.4 var(--font-body);
  text-align: start;
}

.directory-link .t-icon { flex: none; font-size: 16px; }
.directory-link span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.directory-root { margin-bottom: 2px; }
.directory-link:hover, .directory-icon:hover { background: var(--workspace-selected); }
.directory-root[aria-current], .directory-row.is-current { color: var(--workspace-accent); background: var(--workspace-selected); }
.directory-row.is-current .directory-link { font-weight: 650; }
.workspace-directory .is-drop-target { outline: 2px dashed var(--workspace-accent); outline-offset: -2px; }
.directory-feedback { padding: 10px 8px; color: var(--workspace-muted); font-size: 12px; }
.directory-feedback button { color: var(--workspace-accent); padding: 7px 0; text-decoration: underline; }
.workspace-directory :is(a, button):focus-visible { outline: 2px solid var(--workspace-accent); outline-offset: -2px; }

@media (pointer: coarse) {
  .directory-link, .directory-icon { min-height: 44px; }
  .directory-expander, .directory-heading .directory-icon { width: 44px; }
}
</style>
