<template>
  <t-dialog v-model:visible="dialogVisible" header="标签管理" width="480px" @close="handleClose">
    <!-- 创建标签 -->
    <div class="mb-4">
      <div class="mb-2">
        <t-input v-model="newTagName" placeholder="输入标签名称（最多50字）" :maxlength="50" autocomplete="off" name="tag-name" @enter="handleCreate" />
      </div>
      <div class="flex gap-1.5 flex-wrap mb-2">
        <button
          v-for="c in presetColors"
          :key="c"
          type="button"
          class="w-6 h-6 rounded-full cursor-pointer border-2 transition-transform"
          :class="newTagColor === c ? 'border-surface ring-2 ring-brand scale-105' : 'border-transparent'"
          :style="{ background: c }"
          :aria-label="`选择颜色 ${c}`"
          @click="newTagColor = c"
        />
      </div>
      <t-button block theme="primary" size="small" :disabled="!newTagName.trim()" @click="handleCreate">创建标签</t-button>
    </div>

    <!-- 搜索标签 -->
    <div v-if="tagStore.tags && tagStore.tags.length > 0" class="mb-3">
      <t-input v-model="tagSearch" placeholder="搜索标签名称..." clearable size="small" autocomplete="off" name="tag-search" />
    </div>

    <!-- 标签列表 -->
    <div v-if="(!filteredTags || filteredTags.length === 0) && !tagStore.loading" class="text-center p-6 text-ink-muted">
      {{ tagSearch ? '没有匹配的标签' : '暂无标签，输入名称创建第一个标签' }}
    </div>
    <div v-else class="max-h-75 overflow-y-auto">
      <div
        v-for="tag in filteredTags"
        :key="tag.id"
        class="flex items-center justify-between py-2 border-b border-line cursor-pointer"
        :class="selectedTagIds.includes(tag.id) ? 'bg-brand-soft' : 'bg-transparent'"
        @click="toggleTagFilter(tag.id)"
      >
        <div class="flex items-center gap-2">
          <div
            class="w-3.5 h-3.5 rounded-full shrink-0"
            :style="{ background: tag.color }"
          />
          <span class="text-ink">{{ tag.name }}</span>
          <span class="text-ink-muted text-xs">（{{ tag.fileCount || 0 }} 个文件）</span>
        </div>
        <t-button
          v-if="tag.userId === currentUserId"
          theme="danger"
          variant="text"
          size="small"
          @click.stop="handleDelete(tag.id)"
        >
          删除
        </t-button>
      </div>
    </div>

    <template #footer>
      <t-button theme="default" @click="handleClose">关闭</t-button>
    </template>
  </t-dialog>
</template>

<script setup lang="ts">
import { ref, computed, watch } from 'vue';
import { DialogPlugin } from 'tdesign-vue-next/es/dialog';
import { useTagStore } from '../stores/tags';
import { useAuthStore } from '../stores/auth';
import MessagePlugin from '@/utils/message';
import { getErrorMessage } from '@/utils/error';

const props = defineProps<{
  visible: boolean;
  selectedTagIds: string[];
}>();

const emit = defineEmits<{
  (e: 'update:visible', value: boolean): void;
  (e: 'filter', tagId: string): void;
}>();

const dialogVisible = ref(false);
const newTagName = ref('');
const newTagColor = ref('#006b5b');
const tagSearch = ref('');
const tagStore = useTagStore();
const authStore = useAuthStore();
const currentUserId = ref('');

const presetColors = [
  '#006b5b', '#0594fa', '#00a870', '#ebb105', '#e37318',
  '#e34d59', '#ed49b4', '#834ec2', '#b2b2b2',
];

const filteredTags = computed(() => {
  if (!tagStore.tags) return [];
  const q = tagSearch.value.trim().toLowerCase();
  if (!q) return tagStore.tags;
  return tagStore.tags.filter(t => t.name.toLowerCase().includes(q));
});

function toggleTagFilter(tagId: string) {
  emit('filter', tagId);
}

watch(() => props.visible, async (val) => {
  dialogVisible.value = val;
  if (val) {
    currentUserId.value = authStore.user?.id || '';
    await tagStore.fetchTags();
    newTagName.value = '';
    newTagColor.value = '#006b5b';
    tagSearch.value = '';
  }
});

function handleClose() {
  emit('update:visible', false);
}

async function handleCreate() {
  const name = newTagName.value.trim();
  if (!name) return;
  try {
    await tagStore.createTag(name, newTagColor.value);
    newTagName.value = '';
    newTagColor.value = '#006b5b';
  } catch (err) {
    MessagePlugin.error(getErrorMessage(err) || '创建标签失败');
  }
}

// 删除进行中标记：防止快速双击对同一标签触发两次删除请求
const deletingIds = ref(new Set<string>());

async function handleDelete(id: string) {
  if (deletingIds.value.has(id)) return;
  const tag = tagStore.tags?.find((t) => t.id === id);
  const confirmDialog = DialogPlugin.confirm({
    header: '删除标签',
    body: `确定删除标签「${tag?.name || ''}」吗？删除后将解除该标签与文件的关联。`,
    theme: 'warning',
    confirmBtn: '删除',
    cancelBtn: '取消',
    onConfirm: async () => {
      deletingIds.value.add(id);
      try {
        await tagStore.deleteTag(id);
        MessagePlugin.success('标签已删除');
      } catch (err) {
        MessagePlugin.error(getErrorMessage(err) || '删除标签失败');
      } finally {
        deletingIds.value.delete(id);
        confirmDialog.destroy();
      }
    },
    onClose: () => confirmDialog.destroy(),
  });
}
</script>
