<template>
  <div>
    <div class="api-key-header">
      <div>
        <h3 class="section-title">API 密钥</h3>
        <p class="section-desc">
          创建密钥后，可通过 <code>X-API-Key</code> 请求头调用文件 API
          （上传、下载、重命名、删除、移动、创建文件夹等）。密钥仅能操作本账号的文件。
        </p>
      </div>
      <t-button theme="primary" :disabled="createVisible" @click="openCreate">
        <template #icon><t-icon name="add" /></template>
        创建密钥
      </t-button>
    </div>

    <!-- 创建表单 -->
    <div v-if="createVisible" class="create-row">
      <t-input
        v-model="newKeyName"
        placeholder="密钥名称（可选，便于识别用途）"
        maxlength="64"
        clearable
        @enter="submitCreate"
      />
      <t-button theme="primary" :loading="creating" @click="submitCreate">确认创建</t-button>
      <t-button variant="outline" @click="createVisible = false">取消</t-button>
    </div>

    <!-- 密钥列表 -->
    <t-table
      v-if="keys.length > 0"
      :data="keys"
      :columns="columns"
      row-key="id"
      size="small"
      class="key-table"
    >
      <template #status="{ row }">
        <t-tag v-if="!row.revokedAt" theme="success" variant="light">有效</t-tag>
        <t-tag v-else theme="default" variant="light">已撤销</t-tag>
      </template>
      <template #createdAt="{ row }">{{ formatDate(row.createdAt) }}</template>
      <template #lastUsedAt="{ row }">{{ formatDateTime(row.lastUsedAt) }}</template>
      <template #op="{ row }">
        <t-space size="small">
          <t-popconfirm content="撤销后该密钥立即失效，确定撤销？" @confirm="handleRevoke(row)">
            <t-link theme="danger" :disabled="!!row.revokedAt">撤销</t-link>
          </t-popconfirm>
          <t-link theme="primary" :disabled="!!row.revokedAt" @click="handleRotate(row)">轮换</t-link>
        </t-space>
      </template>
    </t-table>
    <div v-else class="empty-hint">还没有 API 密钥，点击「创建密钥」开始使用。</div>

    <!-- 明文密钥一次性展示 -->
    <t-dialog
      :visible="!!createdKey"
      header="密钥已创建"
      :on-close="closeSecretDialog"
      :footer="false"
      width="480px"
    >
      <t-alert theme="warning" class="secret-alert">
        请立即保存此密钥，关闭本窗口后将无法再次查看，只能撤销重建。
      </t-alert>
      <div class="secret-row">
        <t-input :value="createdKey?.key" readonly class="secret-input" />
        <t-button theme="primary" @click="copySecret">复制</t-button>
      </div>
      <div class="secret-meta">
        名称：{{ createdKey?.name }} · 前缀：{{ createdKey?.prefix }}
      </div>
      <t-button block variant="outline" style="margin-top: 16px" @click="closeSecretDialog">
        我已保存，关闭
      </t-button>
    </t-dialog>
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted } from 'vue';
import MessagePlugin from '@/utils/message';
import { getErrorMessage } from '@/utils/error';
import {
  listApiKeys,
  createApiKey,
  revokeApiKey,
  rotateApiKey,
  type ApiKeySummary,
  type CreatedApiKey,
} from '../../api/api-keys';

const keys = ref<ApiKeySummary[]>([]);
const loading = ref(false);

const createVisible = ref(false);
const newKeyName = ref('');
const creating = ref(false);

const createdKey = ref<CreatedApiKey | null>(null);

const columns = [
  { colKey: 'name', title: '名称', ellipsis: true },
  { colKey: 'prefix', title: '前缀', cell: (_h: unknown, { row }: { row: ApiKeySummary }) => row.prefix, width: 170 },
  { colKey: 'status', title: '状态', width: 90 },
  { colKey: 'createdAt', title: '创建时间', width: 110 },
  { colKey: 'lastUsedAt', title: '最近使用', width: 160 },
  { colKey: 'op', title: '操作', width: 130 },
] as const;

async function loadKeys() {
  loading.value = true;
  try {
    keys.value = await listApiKeys();
  } catch (error: unknown) {
    MessagePlugin.error(getErrorMessage(error) || '加载密钥列表失败');
  } finally {
    loading.value = false;
  }
}

function openCreate() {
  createVisible.value = true;
  newKeyName.value = '';
}

async function submitCreate() {
  if (creating.value) return;
  creating.value = true;
  try {
    createdKey.value = await createApiKey(newKeyName.value.trim() || undefined);
    createVisible.value = false;
    newKeyName.value = '';
    await loadKeys();
  } catch (error: unknown) {
    MessagePlugin.error(getErrorMessage(error) || '创建密钥失败');
  } finally {
    creating.value = false;
  }
}

async function handleRevoke(row: ApiKeySummary) {
  try {
    await revokeApiKey(row.id);
    MessagePlugin.success('密钥已撤销');
    await loadKeys();
  } catch (error: unknown) {
    MessagePlugin.error(getErrorMessage(error) || '撤销失败');
  }
}

async function handleRotate(row: ApiKeySummary) {
  try {
    createdKey.value = await rotateApiKey(row.id);
    MessagePlugin.success('已轮换：旧密钥已撤销，请保存新密钥');
    await loadKeys();
  } catch (error: unknown) {
    MessagePlugin.error(getErrorMessage(error) || '轮换失败');
  }
}

async function copySecret() {
  if (!createdKey.value) return;
  try {
    await navigator.clipboard.writeText(createdKey.value.key);
    MessagePlugin.success('密钥已复制');
  } catch {
    MessagePlugin.error('复制失败，请手动复制');
  }
}

function closeSecretDialog() {
  createdKey.value = null;
}

function formatDate(date: string) {
  return date ? new Date(date).toLocaleDateString('zh-CN') : '-';
}

function formatDateTime(date: string | null) {
  if (!date) return '从未使用';
  const d = new Date(date);
  return `${d.toLocaleDateString('zh-CN')} ${d.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}`;
}

onMounted(loadKeys);
</script>

<style scoped>
.api-key-header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
  margin-bottom: 16px;
}

.section-title {
  margin: 0 0 8px;
  font-family: var(--font-display);
  font-size: 16px;
  font-weight: 600;
}

.section-desc {
  margin: 0;
  font-size: 13px;
  color: var(--text-secondary);
  max-width: 560px;
}

.section-desc code {
  font-family: var(--font-mono);
  font-size: 12px;
  color: var(--text-accent);
  background: var(--color-accent-soft);
  padding: 1px 5px;
  border-radius: 4px;
}

.create-row {
  display: flex;
  gap: 8px;
  margin-bottom: 16px;
}

.create-row .t-input {
  flex: 1;
}

.key-table {
  margin-top: 4px;
}

.empty-hint {
  padding: 24px 0;
  font-size: 13px;
  color: var(--text-tertiary);
  text-align: center;
}

.secret-alert {
  margin-bottom: 16px;
}

.secret-row {
  display: flex;
  gap: 8px;
}

.secret-input {
  flex: 1;
}

.secret-input :deep(input) {
  font-family: var(--font-mono);
  font-size: 13px;
}

.secret-meta {
  margin-top: 8px;
  font-size: 12px;
  color: var(--text-tertiary);
}
</style>
