<template>
  <t-dialog
    :visible="visible"
    :header="dialogHeader"
    :on-confirm="handleConfirm"
    :on-close="handleClose"
    :confirm-loading="loading"
    width="480px"
  >
    <div class="move-dialog-body">
      <div v-if="targetKind === 'file' && targetIds.length > 1" class="batch-hint">
        将移动 {{ targetIds.length }} 个文件到所选文件夹
      </div>
      <div class="target-picker">
        <div
          class="target-item"
          :class="{ active: selectedId === null }"
          @click="selectedId = null"
        >
          <t-icon name="folder-opened" class="folder-icon" />
          <span>我的文件（根目录）</span>
        </div>
        <div class="tree-scroll">
          <t-tree
            :data="treeData"
            :keys="{ value: 'id', label: 'name', children: 'children' }"
            :value="selectedId || ''"
            @change="onSelect"
            :expanded="expandedKeys"
            @expand="expandedKeys = $event"
            hover
            transition
            activable
            line
          />
        </div>
      </div>

      <div v-if="errorMessage" class="error-msg">{{ errorMessage }}</div>
    </div>
  </t-dialog>
</template>

<script setup lang="ts">
import { ref, computed, watch } from 'vue';
import { MessagePlugin } from 'tdesign-vue-next';
import { useFolderStore, type Folder } from '../../stores/folders';

const props = defineProps<{
  visible: boolean;
  /** 移动目标的类型：folder（单个文件夹）或 file（一个或多个文件） */
  targetKind: 'folder' | 'file';
  /** 目标 ID 数组（folder 模式下长度为 1；file 模式下可多个） */
  targetIds: string[];
  /** 禁止选择为目标的 folderId 列表（用于循环检测，folder 模式专用） */
  disabledIds?: string[];
}>();

const emit = defineEmits<{
  'update:visible': [v: boolean];
  moved: [];
}>();

const folderStore = useFolderStore();
const selectedId = ref<string | null>(null);
const loading = ref(false);
const errorMessage = ref('');
const expandedKeys = ref<string[]>([]);

const dialogHeader = computed(() => {
  if (props.targetKind === 'folder') return '移动文件夹到...';
  if (props.targetIds.length === 1) return '移动文件到...';
  return `移动 ${props.targetIds.length} 个文件到...`;
});

const treeData = computed(() => {
  if (!props.disabledIds?.length) return folderStore.tree;
  // 从树中过滤掉 disabled 节点（避免循环移动）
  const filter = (nodes: Folder[]): Folder[] => {
    return nodes
      .filter((n) => !props.disabledIds!.includes(n.id))
      .map((n) => ({ ...n, children: n.children ? filter(n.children) : [] }));
  };
  return filter(folderStore.tree);
});

watch(() => props.visible, (v) => {
  if (v) {
    selectedId.value = null;
    errorMessage.value = '';
  }
});

function onSelect(value: string) {
  selectedId.value = value === '' || value === 'root' ? null : value;
}

async function handleConfirm() {
  if (props.targetIds.length === 0) return;
  loading.value = true;
  errorMessage.value = '';
  try {
    if (props.targetKind === 'folder') {
      // 单个文件夹移动
      await folderStore.moveFolder(props.targetIds[0], selectedId.value);
    } else {
      // 批量文件移动
      let failed = 0;
      for (const fid of props.targetIds) {
        try {
          await folderStore.moveFile(fid, selectedId.value);
        } catch {
          failed++;
        }
      }
      if (failed > 0) {
        MessagePlugin.warning(`${props.targetIds.length - failed} 个成功，${failed} 个失败`);
      }
    }
    MessagePlugin.success('移动成功');
    emit('update:visible', false);
    emit('moved');
  } catch (err: any) {
    errorMessage.value = err?.response?.data?.message || err?.message || '移动失败';
  } finally {
    loading.value = false;
  }
}

function handleClose() {
  emit('update:visible', false);
}
</script>

<style scoped>
.move-dialog-body {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.batch-hint {
  padding: 8px 12px;
  background: var(--td-brand-color-focus);
  color: var(--td-brand-color);
  border-radius: 4px;
  font-size: 13px;
}

.target-picker {
  border: 1px solid var(--td-border-level-2-color);
  border-radius: 6px;
  overflow: hidden;
}

.target-item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 12px;
  cursor: pointer;
  font-size: 14px;
  border-bottom: 1px solid var(--td-border-level-1-color);
}

.target-item:hover {
  background: var(--td-bg-color-container-hover);
}

.target-item.active {
  background: var(--td-brand-color-focus);
  color: var(--td-brand-color);
}

.folder-icon {
  color: var(--td-warning-color);
}

.tree-scroll {
  max-height: 320px;
  overflow-y: auto;
  padding: 4px 0;
}

.error-msg {
  padding: 8px 12px;
  background: var(--td-error-color-1);
  color: var(--td-error-color);
  border-radius: 4px;
  font-size: 13px;
}
</style>
