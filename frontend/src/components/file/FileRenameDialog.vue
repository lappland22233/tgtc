<template>
  <t-dialog
    :visible="visible"
    header="重命名文件"
    :on-confirm="handleConfirm"
    :on-close="handleClose"
    :confirm-loading="loading"
    width="400px"
  >
    <t-form :data="form" :rules="rules" ref="formRef">
      <t-form-item label="文件名称" name="name">
        <t-input
          v-model="form.name"
          placeholder="请输入新文件名"
          maxlength="255"
          clearable
          autofocus
          @enter="handleConfirm"
        />
      </t-form-item>
    </t-form>
  </t-dialog>
</template>

<script setup lang="ts">
import { ref, reactive, watch } from 'vue';
import MessagePlugin from '@/utils/message';
import { getErrorMessage } from '@/utils/error';
import { useFileStore } from '../../stores/files';
import type { FileItem } from '../../types/file';

const props = defineProps<{
  visible: boolean;
  file: FileItem | null;
}>();

const emit = defineEmits<{
  'update:visible': [v: boolean];
  renamed: [];
}>();

const fileStore = useFileStore();
const loading = ref(false);
const formRef = ref();

const form = reactive({ name: '' });
const rules = {
  name: [
    { required: true, message: '请输入文件名称', type: 'error' as const },
    { max: 255, message: '文件名称不能超过 255 个字符', type: 'error' as const },
  ],
};

watch(() => props.visible, (v) => {
  if (v && props.file) {
    form.name = props.file.originalName;
  } else if (v) {
    form.name = '';
  }
});

async function handleConfirm() {
  const valid = await formRef.value?.validate();
  if (valid !== true || !props.file) return;

  loading.value = true;
  try {
    await fileStore.renameFile(props.file.id, form.name.trim());
    MessagePlugin.success('已重命名');
    emit('update:visible', false);
    emit('renamed');
  } catch (err) {
    MessagePlugin.error(getErrorMessage(err) || '重命名失败');
  } finally {
    loading.value = false;
  }
}

function handleClose() {
  emit('update:visible', false);
}
</script>
