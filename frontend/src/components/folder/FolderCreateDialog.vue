<template>
  <t-dialog
    :visible="visible"
    header="新建文件夹"
    :on-confirm="handleConfirm"
    :on-close="handleClose"
    :confirm-loading="loading"
    width="400px"
  >
    <t-form :data="form" :rules="rules" ref="formRef" @submit="handleConfirm">
      <t-form-item label="文件夹名称" name="name">
        <t-input
          v-model="form.name"
          placeholder="请输入文件夹名称"
          maxlength="255"
          clearable
          autofocus
          @enter="handleConfirm"
        />
      </t-form-item>
      <div v-if="parentName" class="parent-hint">
        将创建在：<strong>{{ parentName }}</strong>
      </div>
    </t-form>
  </t-dialog>
</template>

<script setup lang="ts">
import { ref, reactive, watch, computed } from 'vue';
import { MessagePlugin } from 'tdesign-vue-next';
import { useFolderStore } from '../../stores/folders';
import type { Folder } from '../../stores/folders';

const props = defineProps<{
  visible: boolean;
  /** 父文件夹 ID；null 表示在根目录创建 */
  parentId: string | null;
}>();

const emit = defineEmits<{
  'update:visible': [visible: boolean];
  created: [folder: Folder];
}>();

const folderStore = useFolderStore();
const loading = ref(false);
const formRef = ref();

const form = reactive({ name: '' });

const rules = {
  name: [
    { required: true, message: '请输入文件夹名称', type: 'error' as const },
    { max: 255, message: '文件夹名称不能超过 255 个字符', type: 'error' as const },
  ],
};

const parentName = computed(() => {
  if (!props.parentId) return '我的文件（根目录）';
  const folder = folderStore.findInTree(folderStore.tree, props.parentId);
  return folder?.name || '';
});

// 弹窗打开时清空输入
watch(() => props.visible, (v) => {
  if (v) form.name = '';
});

async function handleConfirm() {
  const valid = await formRef.value?.validate();
  if (valid !== true) return;

  loading.value = true;
  try {
    const folder = await folderStore.createFolder(form.name.trim(), props.parentId);
    MessagePlugin.success('文件夹创建成功');
    emit('update:visible', false);
    emit('created', folder);
  } catch (err: any) {
    const msg = err?.response?.data?.message || err?.message || '创建失败';
    MessagePlugin.error(msg);
  } finally {
    loading.value = false;
  }
}

function handleClose() {
  emit('update:visible', false);
}
</script>

<style scoped>
.parent-hint {
  margin-top: 8px;
  font-size: 13px;
  color: var(--td-text-color-secondary);
}
</style>
