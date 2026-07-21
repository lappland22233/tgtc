<template>
  <div class="folder-breadcrumb">
    <t-breadcrumb :max-item="10">
      <t-breadcrumb-item @click="openFolder(null)">
        我的文件
      </t-breadcrumb-item>
      <t-breadcrumb-item
        v-for="folder in folderStore.breadcrumb"
        :key="folder.id"
        @click="openFolder(folder.id)"
      >
        {{ folder.name }}
      </t-breadcrumb-item>
    </t-breadcrumb>
  </div>
</template>

<script setup lang="ts">
import { useFolderStore } from '../../stores/folders';

const folderStore = useFolderStore();
const emit = defineEmits<{ navigate: [folderId: string | null] }>();

function openFolder(folderId: string | null) {
  // 通过事件通知父组件，避免直接修改 store 触发多次刷新
  emit('navigate', folderId);
}
</script>

<style scoped>
.folder-breadcrumb {
  display: flex;
  align-items: center;
  padding: 8px 0;
  font-size: 14px;
}

.folder-breadcrumb :deep(.t-breadcrumb__item) {
  cursor: pointer;
  user-select: none;
}

.folder-breadcrumb :deep(.t-breadcrumb__item:hover) {
  color: var(--td-brand-color);
}
</style>
