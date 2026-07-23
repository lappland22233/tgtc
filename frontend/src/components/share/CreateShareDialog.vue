<template>
  <t-dialog
    :visible="visible"
    header="创建分享链接"
    :on-confirm="handleConfirm"
    :on-close="handleClose"
    :confirm-loading="loading"
    width="480px"
  >
    <t-form :data="form" :rules="rules" ref="formRef" label-width="100px">
      <t-form-item label="分享目标">
        <div class="target-info">
          <span class="target-icon">{{ targetType === 'folder' ? '📁' : '📄' }}</span>
          <span class="target-name" :title="targetName">{{ targetName }}</span>
        </div>
      </t-form-item>

      <t-form-item label="访问密码" name="password">
        <t-input
          v-model="form.password"
          type="password"
          placeholder="留空表示公开分享"
          clearable
          maxlength="128"
        />
        <div class="form-hint">设置密码后，访问者需输入密码才能查看文件信息</div>
      </t-form-item>

      <t-form-item label="访问次数" name="maxAccessCount">
        <t-select v-model="form.maxAccessCount" :options="accessCountOptions" />
        <div class="form-hint">-1 表示不限制访问次数</div>
      </t-form-item>

      <t-form-item label="有效期" name="expiresIn">
        <t-select v-model="form.expiresIn" :options="expiryOptions" />
        <div class="form-hint">从首次访问开始计时，null 表示永久有效</div>
      </t-form-item>
    </t-form>

    <!-- 创建成功后显示分享链接 -->
    <div v-if="shareResult" class="share-result">
      <div class="result-label">分享链接已创建：</div>
      <div class="result-url-row">
        <t-input :value="shareResult.url" readonly class="result-url" />
        <t-button theme="primary" @click="copyLink">复制链接</t-button>
      </div>
      <div class="result-hint">
        <span v-if="form.password">🔒 加密分享</span>
        <span v-else>🌐 公开分享</span>
        <span v-if="form.maxAccessCount > 0"> · 限 {{ form.maxAccessCount }} 次访问</span>
        <span v-if="form.expiresIn"> · {{ form.expiresIn }} 小时有效</span>
      </div>
    </div>
  </t-dialog>
</template>

<script setup lang="ts">
import { ref, reactive, watch } from 'vue';
import MessagePlugin from '@/utils/message';
import { getErrorMessage } from '@/utils/error';
import { api } from '../../stores/auth';

const props = defineProps<{
  visible: boolean;
  targetType: 'file' | 'folder';
  targetId: string;
  targetName: string;
}>();

const emit = defineEmits<{
  'update:visible': [v: boolean];
  created: [result: { token: string; url: string; id: string }];
}>();

const loading = ref(false);
const formRef = ref();
const shareResult = ref<{ token: string; url: string; id: string } | null>(null);

const form = reactive({
  password: '',
  maxAccessCount: -1,
  expiresIn: null as number | null,
});

const rules = {
  password: [
    { max: 128, message: '密码不能超过 128 个字符', type: 'error' as const },
  ],
};

const accessCountOptions = [
  { label: '不限制', value: -1 },
  { label: '1 次', value: 1 },
  { label: '5 次', value: 5 },
  { label: '10 次', value: 10 },
  { label: '50 次', value: 50 },
  { label: '100 次', value: 100 },
];

const expiryOptions = [
  { label: '永久有效', value: null },
  { label: '1 小时', value: 1 },
  { label: '6 小时', value: 6 },
  { label: '12 小时', value: 12 },
  { label: '1 天', value: 24 },
  { label: '3 天', value: 72 },
  { label: '7 天', value: 168 },
  { label: '30 天', value: 720 },
];

// 弹窗打开时重置表单
watch(() => props.visible, (v) => {
  if (v) {
    form.password = '';
    form.maxAccessCount = -1;
    form.expiresIn = null;
    shareResult.value = null;
  }
});

async function handleConfirm() {
  // 如果已经创建成功，再次点击确认 = 关闭弹窗
  if (shareResult.value) {
    handleClose();
    return;
  }

  const valid = await formRef.value?.validate();
  if (valid !== true) return;

  loading.value = true;
  try {
    const res = await api.post('/shares', {
      targetType: props.targetType,
      targetId: props.targetId,
      password: form.password || undefined,
      maxAccessCount: form.maxAccessCount,
      expiresIn: form.expiresIn,
    });
    const data = res.data.data;
    // 分享页 /s/:token 由前端 SPA 提供服务，实际访问域名即当前站点 origin。
    // 后端返回的 url 基于 APP_URL 环境变量（常指向 API 服务，与前端域名/端口不一致），
    // 直接展示会导致「显示链接 ≠ 实际可访问链接」。统一用 window.location.origin 构建，
    // 与「我的分享」列表（Shares.vue.getShareUrl）保持一致。
    const shareUrl = `${window.location.origin}/s/${data.token}`;
    shareResult.value = { token: data.token, url: shareUrl, id: data.id };
    MessagePlugin.success('分享链接已创建');
    emit('created', shareResult.value);
  } catch (err) {
    MessagePlugin.error(getErrorMessage(err) || '创建分享失败');
  } finally {
    loading.value = false;
  }
}

async function copyLink() {
  if (!shareResult.value) return;
  const link = shareResult.value.url;

  // 优先使用 Clipboard API（仅安全上下文可用）
  if (navigator.clipboard && window.isSecureContext) {
    try {
      await navigator.clipboard.writeText(link);
      MessagePlugin.success('链接已复制到剪贴板');
      return;
    } catch {
      // 继续尝试降级方案
    }
  }

  // 降级方案：HTTP 内网部署时 Clipboard API 不可用，
  // 使用临时 textarea + execCommand('copy') 完成复制
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
  gap: 8px;
  padding: 8px 12px;
  background: var(--td-bg-color-secondarycontainer);
  border-radius: 6px;
  font-size: 14px;
}

.target-icon {
  font-size: 20px;
}

.target-name {
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-weight: 500;
}

.form-hint {
  font-size: 12px;
  color: var(--td-text-color-placeholder);
  margin-top: 4px;
}

.share-result {
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
  display: flex;
  gap: 8px;
}
</style>
