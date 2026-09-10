<template>
  <!-- 批量操作栏：仅在选中文件时出现 -->
  <div v-if="selectedCount > 0" class="fl-batchbar">
    <span class="fl-batchbar-count">已选 {{ selectedCount }} 项</span>
    <!-- G11-09：MK 按钮与“复制下载链接”按钮并列显示，不再互斥（避免全选图片时复制入口被挤掉）。
          MK 仅对可直链的图片生成 Markdown；复制链接对全部选中项生成下载链接。 -->
    <t-button
      v-if="imageCount > 0"
      theme="primary"
      variant="outline"
      size="small"
      @click="emit('convert-markdown')"
    >
      批量 MK（{{ imageCount }}）
    </t-button>
    <t-button
      theme="default"
      variant="outline"
      size="small"
      @click="emit('copy-links')"
    >
      复制下载链接
    </t-button>
    <t-button theme="default" variant="outline" size="small" @click="emit('batch-tag')">批量标签</t-button>
    <t-button theme="default" variant="outline" size="small" @click="emit('move')">移动到...</t-button>
    <t-button
      theme="danger"
      variant="outline"
      size="small"
      :loading="busy"
      :disabled="busy"
      @click="emit('batch-delete')"
    >
      批量删除
    </t-button>
    <t-button theme="default" variant="text" size="small" :disabled="busy" @click="emit('clear-selection')">清除选择</t-button>
  </div>

  <!-- 已选标签筛选 -->
  <div v-if="tagFilters.length > 0" class="fl-tagfilters">
    <t-tag
      v-for="tag in tagFilters"
      :key="tag.id"
      closable
      size="small"
      theme="primary"
      variant="light"
      @close="emit('remove-tag', tag.id)"
    >
      {{ tag.name }}
    </t-tag>
    <t-button size="small" variant="text" @click="emit('clear-tags')">清除全部</t-button>
  </div>

  <!-- Markdown 结果区域 -->
  <div v-if="markdown" class="fl-markdown">
    <div class="fl-markdown-head">
      <span class="fl-markdown-title">Markdown 结果</span>
      <div class="fl-markdown-actions">
        <t-button size="small" theme="primary" variant="outline" @click="emit('copy-markdown')">复制</t-button>
        <t-button size="small" theme="default" variant="text" @click="emit('update:markdown', '')">关闭</t-button>
      </div>
    </div>
    <t-input
      :model-value="markdown"
      type="textarea"
      readonly
      :rows="6"
      autocomplete="off"
      @update:model-value="emit('update:markdown', $event)"
    />
  </div>
</template>

<script setup lang="ts">
/**
 * 文件列表批量操作区（M6 拆分：从 FileList.vue 拆出）。
 *
 * 纯展示组件，含三个互不依赖、各自独立显隐的区块（拆分前即为三个兄弟节点，
 * 因此本组件为多根节点，渲染位置与顺序不变）：
 * 1. 批量操作栏（选中文件时出现）
 * 2. 已选标签筛选条
 * 3. Markdown 结果区域
 *
 * 标签名由宿主预解析为 { id, name }，组件不访问 store（保持可测与解耦）。
 */
defineProps<{
  /** 已选文件数；0 表示不展示批量栏 */
  selectedCount: number;
  /** 已选中的可直链图片数；0 表示不展示 MK 按钮 */
  imageCount: number;
  /** 批量操作进行中（禁用互斥按钮） */
  busy: boolean;
  /** 已选标签筛选（名称由宿主解析） */
  tagFilters: Array<{ id: string; name: string }>;
  /** Markdown 结果文本；空串表示不展示结果区 */
  markdown: string;
}>();

const emit = defineEmits<{
  'update:markdown': [value: string];
  'convert-markdown': [];
  'copy-links': [];
  'batch-tag': [];
  move: [];
  'batch-delete': [];
  'clear-selection': [];
  'remove-tag': [tagId: string];
  'clear-tags': [];
  'copy-markdown': [];
}>();
</script>

<style scoped>
/* ============ 批量操作栏 ============ */
.fl-batchbar {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
  padding: 10px 12px;
  margin-bottom: 16px;
  background: var(--color-accent-soft);
  border: 1px solid var(--border-accent);
  border-radius: var(--radius-md);
}

.fl-batchbar-count {
  font-size: 13px;
  font-weight: 500;
  color: var(--color-accent);
  margin-right: 4px;
}

/* ============ 标签筛选 ============ */
.fl-tagfilters {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
  margin-bottom: 16px;
}

/* ============ Markdown 结果 ============ */
.fl-markdown {
  margin-bottom: 16px;
  padding: 16px;
  background: var(--color-bg-elevated);
  border-radius: var(--radius-md);
  border: 1px solid var(--border-default);
}

.fl-markdown-head {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 8px;
}

.fl-markdown-title {
  font-weight: 500;
}

.fl-markdown-actions {
  display: flex;
  gap: 8px;
}
</style>
