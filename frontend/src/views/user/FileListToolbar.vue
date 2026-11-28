<template>
  <div class="fl-toolbar">
    <form autocomplete="off" class="fl-search-form" @submit.prevent="emit('search')">
      <t-input
        :model-value="search"
        placeholder="搜索当前文件夹"
        aria-label="搜索当前文件夹"
        class="fl-search-input"
        autocomplete="off"
        name="q-file-search"
        clearable
        @update:model-value="emit('update:search', $event)"
        @enter="emit('search')"
        @clear="emit('clear')"
      >
        <template #prefix-icon><t-icon name="search" aria-hidden="true" /></template>
      </t-input>
      <t-button class="fl-search-submit" variant="text" @click="emit('search')">搜索</t-button>
    </form>
    <div class="fl-toolbar-right">
      <t-button class="fl-tag-button" variant="outline" @click="emit('manage-tags')">
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
  gap: 8px;
  flex-wrap: wrap;
  margin-bottom: 10px;
}

.fl-search-form {
  display: flex;
  flex: 1 1 100%;
  min-width: 0;
  align-items: center;
  margin: 0;
  border: 1px solid var(--workspace-border);
  border-radius: 8px;
  background: var(--workspace-canvas);
}

.fl-search-form:focus-within {
  border-color: var(--workspace-accent);
  box-shadow: 0 0 0 2px var(--workspace-selected);
}

.fl-search-input {
  flex: 1;
  min-width: 0;
}

.fl-search-form :deep(.t-input) {
  border: 0;
  min-height: 42px;
  background: transparent;
  box-shadow: none;
}

.fl-search-form :deep(.t-input__inner) {
  color: var(--workspace-text);
  font-size: 16px;
}

.fl-search-form :deep(.t-input__inner::placeholder),
.fl-search-form :deep(.t-input__prefix) {
  color: var(--workspace-muted);
}

.fl-search-form .fl-search-submit,
.fl-toolbar-right .fl-tag-button {
  min-height: 44px;
  border-radius: 8px;
  color: var(--workspace-text);
}

.fl-search-form .fl-search-submit {
  margin-inline-end: 2px;
  color: var(--workspace-muted);
}

.fl-toolbar-right .fl-tag-button {
  border-color: var(--workspace-border);
  background: var(--workspace-surface);
}

.fl-search-form .fl-search-submit:hover,
.fl-toolbar-right .fl-tag-button:hover {
  background: var(--workspace-selected);
  color: var(--workspace-accent);
}

@media (min-width: 481px) {
  .fl-search-form {
    flex: 1 1 150px;
  }
}

@media (min-width: 769px) {
  .fl-search-form :deep(.t-input) {
    min-height: 34px;
  }

  .fl-search-form :deep(.t-input__inner) {
    font-size: 14px;
  }

  .fl-search-form .fl-search-submit,
  .fl-toolbar-right .fl-tag-button {
    min-height: 36px;
  }

  .fl-search-form .fl-search-submit {
    min-height: 32px;
  }
}

@media (pointer: coarse) {
  .fl-search-form .fl-search-submit,
  .fl-toolbar-right .fl-tag-button {
    min-height: 44px;
  }
}
</style>
