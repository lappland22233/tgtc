<template>
  <div class="fl-toolbar">
    <form autocomplete="off" class="fl-search-form" @submit.prevent="emit('search')">
      <t-input
        :model-value="search"
        placeholder="搜索当前文件夹..."
        class="fl-search-input"
        autocomplete="off"
        name="q-file-search"
        clearable
        @update:model-value="emit('update:search', $event)"
        @enter="emit('search')"
        @clear="emit('clear')"
      >
        <template #prefix-icon><t-icon name="search" /></template>
      </t-input>
      <t-button theme="default" @click="emit('search')">搜索</t-button>
    </form>
    <div class="fl-toolbar-right">
      <t-button size="medium" variant="outline" @click="emit('manage-tags')">
        <template #icon><t-icon name="tag" /></template>
        {{ tagButtonLabel }}
      </t-button>
    </div>
  </div>
</template>

<script setup lang="ts">
/**
 * 文件列表工具栏（M6 拆分：从 FileList.vue 拆出）。
 *
 * 纯展示组件：搜索输入框与标签入口的呈现；搜索词经 v-model 双向绑定，
 * 提交/清空/打开标签面板均回传事件，实际查询语义仍由 useFileListQuery 持有。
 */
defineProps<{
  /** 搜索关键词（v-model:search） */
  search: string;
  /** 标签入口文案（由宿主依据标签数量与筛选状态计算） */
  tagButtonLabel: string;
}>();

const emit = defineEmits<{
  'update:search': [value: string];
  search: [];
  clear: [];
  'manage-tags': [];
}>();
</script>

<style scoped>
.fl-toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  flex-wrap: wrap;
  margin-bottom: 16px;
}

.fl-search-form {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 0;
  flex: 1;
  min-width: 220px;
  max-width: 420px;
}

.fl-search-input {
  flex: 1;
}

.fl-toolbar-right {
  display: flex;
  align-items: center;
  gap: 8px;
}

@media (max-width: 768px) {
  .fl-search-form {
    max-width: 100%;
  }
}
</style>
