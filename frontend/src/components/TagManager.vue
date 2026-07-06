<template>
  <t-dialog v-model:visible="dialogVisible" header="标签管理" width="480px" @close="handleClose">
    <!-- 创建标签 -->
    <div style="margin-bottom: 16px;">
      <t-input v-model="newTagName" placeholder="输入标签名称（最多50字）" style="margin-bottom: 8px;" autocomplete="off" name="tag-name" />
      <div style="display: flex; gap: 6px; flex-wrap: wrap; margin-bottom: 8px;">
        <div
          v-for="c in presetColors"
          :key="c"
          :style="{
            width: '24px', height: '24px', borderRadius: '50%', background: c,
            border: newTagColor === c ? '3px solid #fff' : '2px solid transparent',
            cursor: 'pointer', boxSizing: 'border-box'
          }"
          @click="newTagColor = c"
        />
      </div>
      <t-button block theme="primary" size="small" :disabled="!newTagName.trim()" @click="handleCreate">创建标签</t-button>
    </div>

    <!-- 标签列表 -->
    <div v-if="(!tagStore.tags || tagStore.tags.length === 0) && !tagStore.loading" style="text-align: center; padding: 24px; color: var(--text-secondary);">
      暂无标签，输入名称创建第一个标签
    </div>
    <div v-else style="max-height: 300px; overflow-y: auto;">
      <div
        v-for="tag in tagStore.tags"
        :key="tag.id"
        style="display: flex; align-items: center; justify-content: space-between; padding: 8px 0; border-bottom: 1px solid var(--border-color);"
      >
        <div style="display: flex; align-items: center; gap: 8px;">
          <div
            :style="{ width: '14px', height: '14px', borderRadius: '50%', background: tag.color, flexShrink: 0 }"
          />
          <span :style="{ color: 'var(--text-primary)' }">{{ tag.name }}</span>
          <span style="color: var(--text-secondary); font-size: 12px;">（{{ tag.fileCount || 0 }} 个文件）</span>
        </div>
        <t-button
          v-if="tag.userId === currentUserId"
          theme="danger"
          variant="text"
          size="small"
          @click="handleDelete(tag.id)"
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
import { ref, watch } from 'vue';
import { useTagStore } from '../stores/tags';
import { useAuthStore } from '../stores/auth';
import { MessagePlugin } from 'tdesign-vue-next';

const props = defineProps<{
  visible: boolean;
}>();

const emit = defineEmits<{
  (e: 'update:visible', value: boolean): void;
}>();

const dialogVisible = ref(false);
const newTagName = ref('');
const newTagColor = ref('#0052d9');
const tagStore = useTagStore();
const authStore = useAuthStore();
const currentUserId = ref('');

const presetColors = [
  '#0052d9', '#0594fa', '#00a870', '#ebb105', '#e37318',
  '#e34d59', '#ed49b4', '#834ec2', '#b2b2b2',
];

watch(() => props.visible, async (val) => {
  dialogVisible.value = val;
  if (val) {
    currentUserId.value = authStore.user?.id || '';
    await tagStore.fetchTags();
    newTagName.value = '';
    newTagColor.value = '#0052d9';
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
    newTagColor.value = '#0052d9';
  } catch (err: any) {
    const msg = err?.response?.data?.message || '创建标签失败';
    MessagePlugin.error(msg);
  }
}

async function handleDelete(id: string) {
  try {
    await tagStore.deleteTag(id);
  } catch (err: any) {
    const msg = err?.response?.data?.message || '删除标签失败';
    MessagePlugin.error(msg);
  }
}
</script>
