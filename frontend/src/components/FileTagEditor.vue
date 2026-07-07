<template>
  <t-dialog v-model:visible="dialogVisible" header="编辑标签" width="400px" @close="handleClose" :confirm-btn="null">
    <div v-if="tagStore.tags && tagStore.tags.length > 0" style="display: flex; gap: 6px; flex-wrap: wrap;">
      <t-tag
        v-for="tag in tagStore.tags"
        :key="tag.id"
        :theme="selectedIds.has(tag.id) ? 'primary' : 'default'"
        :variant="selectedIds.has(tag.id) ? 'dark' : 'outline'"
        style="cursor: pointer;"
        @click="toggle(tag.id)"
      >
        <span :style="{ display: 'inline-block', width: '8px', height: '8px', borderRadius: '50%', background: tag.color, marginRight: '4px' }" />
        {{ tag.name }}
      </t-tag>
    </div>
    <div v-else style="text-align: center; padding: 16px; color: var(--text-secondary);">
      暂无标签，请先在标签管理中创建
    </div>
    <template #footer>
      <t-button theme="default" @click="handleClose">取消</t-button>
      <t-button theme="primary" :loading="saving" @click="handleSave">保存</t-button>
    </template>
  </t-dialog>
</template>

<script setup lang="ts">
import { ref, watch } from 'vue';
import { useTagStore } from '../stores/tags';
import { api } from '../stores/auth';

const props = defineProps<{
  visible: boolean;
  fileId: string;
  fileTags?: { id: string; name: string; color: string }[];
}>();

const emit = defineEmits<{
  (e: 'update:visible', value: boolean): void;
  (e: 'saved'): void;
}>();

const dialogVisible = ref(false);
const selectedIds = ref(new Set<string>());
const saving = ref(false);
const tagStore = useTagStore();

watch(() => props.visible, async (val) => {
  dialogVisible.value = val;
  if (val) {
    await tagStore.fetchTags();
    selectedIds.value = new Set((props.fileTags || []).map(t => t.id));
  }
});

function toggle(tagId: string) {
  const next = new Set(selectedIds.value);
  if (next.has(tagId)) next.delete(tagId);
  else next.add(tagId);
  selectedIds.value = next;
}

function handleClose() {
  emit('update:visible', false);
}

async function handleSave() {
  saving.value = true;
  try {
    await api.put(`/files/${props.fileId}/tags`, { tagIds: [...selectedIds.value] });
    emit('saved');
    handleClose();
  } catch {
    // 静默处理，saving 在 finally 复位
  } finally {
    saving.value = false;
  }
}
</script>
