<template>
  <t-dialog
    :visible="visible"
    header="重命名文件夹"
    :on-confirm="handleConfirm"
    :on-close="handleClose"
    :confirm-loading="loading"
    width="400px"
  >
    <t-form :data="form" :rules="rules" ref="formRef">
      <t-form-item label="文件夹名称" name="name">
        <t-input
          v-model="form.name"
          placeholder="请输入新文件夹名称"
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
import { MessagePlugin } from 'tdesign-vue-next';
import { useFolderStore, type Folder } from '../../stores/folders';

const props = defineProps<{
  visible: boolean;
  folder: Folder | null;
}>();

const emit = defineEmits<{
  'update:visible': [v: boolean];
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

watch(() => props.visible, (v) => {
  if (v && props.folder) {
    form.name = props.folder.name;
  } else if (v) {
    form.name = '';
  }
});

async function handleConfirm() {
  const valid = await formRef.value?.validate();
  if (valid !== true || !props.folder) return;

  loading.value = true;
  try {
    await folderStore.renameFolder(props.folder.id, form.name.trim());
    MessagePlugin.success('已重命名');
    emit('update:visible', false);
  } catch (err: any) {
    MessagePlugin.error(err?.response?.data?.message || '重命名失败');
  } finally {
    loading.value = false;
  }
}

function handleClose() {
  emit('update:visible', false);
}
</script>
