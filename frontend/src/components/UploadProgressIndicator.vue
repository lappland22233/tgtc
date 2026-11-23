<template>
  <section v-if="uploadStore.entries.length" class="transfer-upload" aria-labelledby="workspace-upload-heading">
    <header class="transfer-upload__summary">
      <h3 id="workspace-upload-heading">上传</h3>
      <span v-if="hasActive">进行中 {{ uploadStore.activeCount }} · 排队 {{ uploadStore.queuedCount }}</span>
      <span v-else>
        {{ uploadStore.successCount }} 个已接收
        <template v-if="uploadStore.errorCount">· {{ uploadStore.errorCount }} 个失败</template>
        <template v-if="uploadStore.cancelledCount">· {{ uploadStore.cancelledCount }} 个取消</template>
      </span>
    </header>

    <div v-if="hasActive" class="transfer-upload__progress">
      <progress :value="uploadStore.overallProgress" max="100" aria-label="上传总进度" />
      <span>{{ uploadStore.overallProgress }}%</span>
      <span v-if="uploadStore.overallSpeed !== '-'">{{ uploadStore.overallSpeed }}</span>
    </div>

    <UploadQueueList
      v-if="isPageVisible"
      class="transfer-upload__list"
      :entries="uploadStore.entries"
      @cancel="uploadStore.cancelOne"
    />

    <div class="transfer-upload__actions">
      <t-button size="small" variant="text" @click="openUploadDetails">查看上传详情</t-button>
      <t-button v-if="hasActive" size="small" variant="text" theme="danger" @click="confirmCancelUploads">
        全部取消
      </t-button>
      <t-button v-if="uploadStore.finishedCount" size="small" variant="text" @click="uploadStore.clearFinished">
        清除已结束
      </t-button>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { DialogPlugin } from 'tdesign-vue-next/es/dialog';
import { usePageVisibility } from '../composables/usePageVisibility';
import { useUploadStore } from '../stores/upload';
import UploadQueueList from './upload/UploadQueueList.vue';

const emit = defineEmits<{ 'open-details': [] }>();
const uploadStore = useUploadStore();
const { isPageVisible } = usePageVisibility();
const router = useRouter();
const route = useRoute();
const pendingTotal = computed(() => uploadStore.activeCount + uploadStore.queuedCount);
const hasActive = computed(() => uploadStore.isPumping || pendingTotal.value > 0);

function openUploadDetails() {
  emit('open-details');
  if (route.name === 'UserFiles') {
    router.push({ query: { ...route.query, uploadDialog: '1' } });
  } else {
    router.push({ path: '/files', query: { uploadDialog: '1' } });
  }
}

function confirmCancelUploads() {
  const dialog = DialogPlugin.confirm({
    header: '取消全部上传',
    body: `确定取消 ${pendingTotal.value} 个进行中或排队中的上传任务吗？`,
    theme: 'warning',
    confirmBtn: '全部取消',
    cancelBtn: '返回',
    onConfirm: () => {
      uploadStore.cancelAll();
      dialog.hide();
    },
  });
}
</script>

<style scoped>
.transfer-upload {
  display: grid;
  gap: 8px;
  min-width: 0;
}

.transfer-upload__summary,
.transfer-upload__actions {
  display: flex;
  align-items: baseline;
  flex-wrap: wrap;
  justify-content: space-between;
  gap: 4px 8px;
}

.transfer-upload__summary h3 {
  margin: 0;
  font-size: 13px;
  font-weight: 600;
}

.transfer-upload__summary span,
.transfer-upload__progress {
  color: var(--workspace-muted);
  font-size: 12px;
}

.transfer-upload__progress {
  display: flex;
  align-items: center;
  gap: 8px;
  font-variant-numeric: tabular-nums;
}

.transfer-upload__progress progress {
  flex: 1;
  min-width: 0;
  height: 7px;
  accent-color: var(--workspace-accent);
}

.transfer-upload .transfer-upload__list {
  height: auto;
  max-height: 14rem;
  contain: content;
}

.transfer-upload__list :deep(.upload-queue-row) {
  border-color: var(--workspace-border);
  background: var(--workspace-canvas);
}

.transfer-upload__actions {
  justify-content: flex-end;
}

@media (pointer: coarse) {
  .transfer-upload :deep(button) {
    min-height: 44px;
    min-width: 44px;
  }
}
</style>
