<template>
  <t-dialog
    :visible="visible"
    header="获取下载链接"
    :on-confirm="handleConfirm"
    :on-close="handleClose"
    :confirm-loading="loading"
    :confirm-btn="result ? '完成' : '生成链接'"
    width="480px"
  >
    <t-form :data="form" label-width="96px">
      <t-form-item label="文件">
        <div class="target-info">
          <span class="target-name" :title="fileName">{{ fileName }}</span>
        </div>
      </t-form-item>

      <t-form-item label="链接类型">
        <t-radio-group v-model="form.mode" variant="default-filled" @change="onModeChange">
          <t-radio-button value="permanent">永久公开</t-radio-button>
          <t-radio-button value="timed">限时公开</t-radio-button>
          <t-radio-button value="count_limited">限次下载</t-radio-button>
        </t-radio-group>
      </t-form-item>

      <t-form-item v-if="form.mode === 'permanent'" label="">
        <div class="form-hint">文件将转换为公开文件，链接永久有效，任何人可访问。</div>
      </t-form-item>

      <t-form-item v-if="form.mode === 'timed'" label="有效时长">
        <t-input-number
          v-model="form.durationHours"
          :min="1"
          :max="720"
          :step="1"
          theme="column"
          style="width: 160px"
        />
        <span class="unit">小时</span>
        <div class="form-hint">1-720 小时（30 天）；从访客首次访问时开始计时。</div>
      </t-form-item>

      <t-form-item v-if="form.mode === 'count_limited'" label="访问次数">
        <t-input-number
          v-model="form.maxAccessCount"
          :min="1"
          :max="1000000"
          :step="1"
          theme="column"
          style="width: 160px"
        />
        <span class="unit">次</span>
        <div class="form-hint">1-1000000 次；达到上限后链接自动失效。</div>
      </t-form-item>
    </t-form>

    <!-- 生成成功后展示链接 -->
    <div v-if="result" class="link-result">
      <div class="result-label">下载链接已生成：</div>
      <div class="result-url-row">
        <t-input :value="browsableUrl" readonly class="result-url" />
        <t-button theme="primary" @click="copyLink">复制链接</t-button>
      </div>
      <div class="result-hint">
        <span v-if="result.mode === 'timed'">{{ result.expiresIn }} 小时内有效</span>
        <span v-else-if="result.mode === 'count_limited'">限 {{ result.maxAccessCount }} 次下载</span>
        <span v-else>公开文件，永久有效</span>
      </div>
    </div>
  </t-dialog>
</template>

<script setup lang="ts">
import { ref, reactive, computed, watch } from 'vue';
import MessagePlugin from '@/utils/message';
import { getErrorMessage } from '@/utils/error';
import { fetchDownloadLink, buildBrowsableLink, type DownloadLinkMode, type DownloadLinkResult } from '../../api/download-link';

const props = defineProps<{
  visible: boolean;
  fileId: string;
  fileName: string;
}>();

const emit = defineEmits<{
  'update:visible': [v: boolean];
}>();

const loading = ref(false);
const result = ref<DownloadLinkResult | null>(null);

const form = reactive({
  // 默认选择限时公开（可逆、影响面最小），避免一键确认即把文件永久公开
  mode: 'timed' as DownloadLinkMode,
  durationHours: 24,
  maxAccessCount: 10,
});

const browsableUrl = computed(() => (result.value ? buildBrowsableLink(result.value) : ''));

function onModeChange() {
  result.value = null;
}

// 打开时重置
watch(() => props.visible, (v) => {
  if (v) {
    form.mode = 'timed';
    form.durationHours = 24;
    form.maxAccessCount = 10;
    result.value = null;
  }
});

async function handleConfirm() {
  if (result.value) {
    handleClose();
    return;
  }
  loading.value = true;
  try {
    result.value = await fetchDownloadLink(props.fileId, form.mode, {
      durationHours: form.durationHours,
      maxAccessCount: form.maxAccessCount,
    });
    MessagePlugin.success('下载链接已生成');
  } catch (err) {
    MessagePlugin.error(getErrorMessage(err) || '生成下载链接失败');
  } finally {
    loading.value = false;
  }
}

async function copyLink() {
  if (!result.value) return;
  const link = browsableUrl.value;
  if (navigator.clipboard && window.isSecureContext) {
    try {
      await navigator.clipboard.writeText(link);
      MessagePlugin.success('链接已复制到剪贴板');
      return;
    } catch {
      // 降级方案
    }
  }
  try {
    const textarea = document.createElement('textarea');
    textarea.value = link;
    textarea.setAttribute('readonly', '');
    textarea.style.position = 'fixed';
    textarea.style.top = '-9999px';
    textarea.style.opacity = '0';
    document.body.appendChild(textarea);
    textarea.select();
    textarea.setSelectionRange(0, textarea.value.length);
    const ok = document.execCommand('copy');
    document.body.removeChild(textarea);
    if (ok) {
      MessagePlugin.success('链接已复制到剪贴板');
    } else {
      MessagePlugin.error('复制失败，请手动复制');
    }
  } catch {
    MessagePlugin.error('复制失败，请手动复制');
  }
}

function handleClose() {
  emit('update:visible', false);
}
</script>

<style scoped>
.target-info {
  display: flex;
  align-items: center;
  padding: 8px 12px;
  background: var(--td-bg-color-secondarycontainer);
  border-radius: 6px;
  font-size: 14px;
  width: 100%;
}

.target-name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-weight: 500;
}

.unit {
  margin-left: 8px;
  font-size: 13px;
  color: var(--td-text-color-secondary);
}

.form-hint {
  font-size: 12px;
  color: var(--td-text-color-placeholder);
  margin-top: 4px;
  width: 100%;
}

.link-result {
  margin-top: 20px;
  padding: 16px;
  background: var(--td-success-color-1);
  border: 1px solid var(--td-success-color-3);
  border-radius: 8px;
}

.result-label {
  font-size: 13px;
  font-weight: 500;
  color: var(--td-success-color);
  margin-bottom: 8px;
}

.result-url-row {
  display: flex;
  gap: 8px;
  margin-bottom: 8px;
}

.result-url {
  flex: 1;
}

.result-url :deep(input) {
  font-family: var(--font-mono);
  font-size: 13px;
}

.result-hint {
  font-size: 12px;
  color: var(--td-text-color-secondary);
}
</style>
