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
          <t-link
            v-if="row.revealable"
            theme="primary"
            :disabled="!!row.revokedAt"
            @click="handleReveal(row)"
          >查看</t-link>
          <t-link theme="primary" :disabled="!!row.revokedAt" @click="handleRotate(row)">轮换</t-link>
          <t-link theme="default" :disabled="!!row.revokedAt" @click="openAllowlist(row)">白名单</t-link>
          <t-link theme="default" @click="openUsage(row)">使用记录</t-link>
          <t-popconfirm content="撤销后该密钥立即失效，确定撤销？" @confirm="handleRevoke(row)">
            <t-link theme="danger" :disabled="!!row.revokedAt">撤销</t-link>
          </t-popconfirm>
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

    <!-- 重显密钥（仅所有者；新密钥可用） -->
    <t-dialog
      :visible="!!revealedKey"
      :header="`查看密钥：${revealedRow?.name || ''}`"
      :on-close="closeRevealDialog"
      :footer="false"
      width="480px"
    >
      <div class="secret-row">
        <t-input :value="revealedKey?.key" readonly class="secret-input" />
        <t-button theme="primary" @click="copyRevealed">复制</t-button>
      </div>
      <div class="secret-meta">请勿将密钥写入日志或公开仓库。</div>
      <t-button block variant="outline" style="margin-top: 16px" @click="closeRevealDialog">关闭</t-button>
    </t-dialog>

    <!-- 每把密钥独立 IP 白名单 -->
    <t-dialog
      :visible="allowlistVisible"
      :header="`IP 白名单：${allowlistRow?.name || ''}`"
      :on-close="closeAllowlist"
      width="520px"
      :confirm-btn="{ content: allowlistLoaded ? '保存' : '加载中…', loading: allowlistSaving, disabled: !allowlistLoaded }"
      @confirm="submitAllowlist"
    >
      <p class="allowlist-hint">
        每行一条规则，支持单 IP 与 CIDR（如 <code>192.168.1.0/24</code>、<code>2408:8456::/32</code>）。
        留空表示不限制来源 IP；保存后该密钥仅允许白名单内的来源调用。
      </p>
      <t-textarea v-model="allowlistText" autosize :maxlength="4000" placeholder="192.168.1.10&#10;10.0.0.0/8" />
    </t-dialog>

    <!-- 使用记录（IP 已脱敏） -->
    <t-dialog
      :visible="usageVisible"
      :header="`使用记录：${usageRow?.name || ''}`"
      :on-close="closeUsage"
      :footer="false"
      width="640px"
    >
      <p class="allowlist-hint">
        最长保留 7 天；来源 IP 已脱敏（仅显示最前与最后一段）。
      </p>
      <t-loading :loading="usageLoading" size="small">
        <div v-if="usageItems.length > 0" class="usage-list">
          <div v-for="item in usageItems" :key="item.id" class="usage-item">
            <div class="usage-item-top">
              <t-tag
                :theme="item.result === 'allowed' ? 'success' : 'danger'"
                variant="light"
                size="small"
              >
                {{ item.result === 'allowed' ? item.statusCode ?? '成功' : 'IP 拒绝' }}
              </t-tag>
              <span class="usage-method">{{ item.method }}</span>
              <span class="usage-route">{{ item.route }}</span>
            </div>
            <div class="usage-item-meta">
              <span>{{ item.maskedIp }}</span>
              <span>{{ formatDateTime(item.createdAt) }}</span>
            </div>
          </div>
        </div>
        <div v-else-if="!usageLoading" class="empty-hint">最近 7 天内没有调用记录。</div>
      </t-loading>
      <div v-if="usageTotal > usageLimit" class="usage-pager">
        <t-button size="small" variant="outline" :disabled="usagePage <= 1" @click="usagePage -= 1">上一页</t-button>
        <span class="usage-pager-info">{{ usagePage }} / {{ Math.ceil(usageTotal / usageLimit) }}</span>
        <t-button
          size="small"
          variant="outline"
          :disabled="usagePage >= Math.ceil(usageTotal / usageLimit)"
          @click="usagePage += 1"
        >下一页</t-button>
      </div>
    </t-dialog>
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted, watch } from 'vue';
import MessagePlugin from '@/utils/message';
import { getErrorMessage } from '@/utils/error';
import {
  listApiKeys,
  createApiKey,
  revokeApiKey,
  rotateApiKey,
  revealApiKey,
  getApiKeyAllowlist,
  setApiKeyAllowlist,
  listApiKeyUsage,
  type ApiKeySummary,
  type ApiKeyUsageItem,
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
  { colKey: 'op', title: '操作', width: 250 },
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

// ---------- 重显密钥（v1.2.6） ----------
const revealedKey = ref<{ key: string } | null>(null);
const revealedRow = ref<ApiKeySummary | null>(null);

async function handleReveal(row: ApiKeySummary) {
  try {
    revealedKey.value = await revealApiKey(row.id);
    revealedRow.value = row;
  } catch (error: unknown) {
    MessagePlugin.error(getErrorMessage(error) || '回显密钥失败');
  }
}

async function copyRevealed() {
  if (!revealedKey.value) return;
  try {
    await navigator.clipboard.writeText(revealedKey.value.key);
    MessagePlugin.success('密钥已复制');
  } catch {
    MessagePlugin.error('复制失败，请手动复制');
  }
}

function closeRevealDialog() {
  revealedKey.value = null;
  revealedRow.value = null;
}

// ---------- 每把密钥独立 IP 白名单（v1.2.6） ----------
const allowlistVisible = ref(false);
const allowlistSaving = ref(false);
const allowlistLoaded = ref(false);
const allowlistRow = ref<ApiKeySummary | null>(null);
const allowlistText = ref('');
// F1：代际令牌。A 的白名单请求慢响应时，用户已切到 B——迟到响应不得回写
// 到 B 的编辑框（跨密钥串写后保存会把 A 的规则写到 B 上）。
let allowlistGeneration = 0;

async function openAllowlist(row: ApiKeySummary) {
  allowlistRow.value = row;
  allowlistVisible.value = true;
  const generation = ++allowlistGeneration;
  allowlistLoaded.value = false;
  allowlistText.value = '';
  try {
    const rules = await getApiKeyAllowlist(row.id);
    if (generation !== allowlistGeneration || allowlistRow.value?.id !== row.id) return;
    allowlistText.value = rules.join('\n');
    // 仅加载成功才允许保存：加载失败时保存会把 PUT [] 发出去，静默清空来源限制。
    allowlistLoaded.value = true;
  } catch (error: unknown) {
    if (generation !== allowlistGeneration || allowlistRow.value?.id !== row.id) return;
    allowlistText.value = '';
    MessagePlugin.error(getErrorMessage(error) || '加载白名单失败');
  }
}

async function submitAllowlist() {
  if (!allowlistRow.value || allowlistSaving.value) return;
  if (!allowlistLoaded.value) {
    MessagePlugin.warning('白名单尚未加载成功，已取消保存（避免误清空来源限制）');
    return;
  }
  allowlistSaving.value = true;
  try {
    const rules = allowlistText.value
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
    await setApiKeyAllowlist(allowlistRow.value.id, rules);
    MessagePlugin.success(rules.length > 0 ? `已保存 ${rules.length} 条白名单规则` : '白名单已清空（不限制来源）');
    allowlistVisible.value = false;
  } catch (error: unknown) {
    MessagePlugin.error(getErrorMessage(error) || '保存白名单失败');
  } finally {
    allowlistSaving.value = false;
  }
}

function closeAllowlist() {
  allowlistGeneration++; // 使在途加载响应失效
  allowlistVisible.value = false;
  allowlistRow.value = null;
  allowlistText.value = '';
  allowlistLoaded.value = false;
}

// ---------- 使用记录（v1.2.6，IP 已脱敏） ----------
const usageVisible = ref(false);
const usageLoading = ref(false);
const usageRow = ref<ApiKeySummary | null>(null);
const usageItems = ref<ApiKeyUsageItem[]>([]);
const usageTotal = ref(0);
const usagePage = ref(1);
const usageLimit = 10;

async function openUsage(row: ApiKeySummary) {
  usageRow.value = row;
  usageVisible.value = true;
  usagePage.value = 1;
  await loadUsage();
}

async function loadUsage() {
  if (!usageRow.value) return;
  usageLoading.value = true;
  try {
    const data = await listApiKeyUsage(usageRow.value.id, usagePage.value, usageLimit);
    usageItems.value = data.items;
    usageTotal.value = data.total;
  } catch (error: unknown) {
    MessagePlugin.error(getErrorMessage(error) || '加载使用记录失败');
  } finally {
    usageLoading.value = false;
  }
}

watch(usagePage, () => {
  void loadUsage();
});

function closeUsage() {
  usageVisible.value = false;
  usageRow.value = null;
  usageItems.value = [];
  usageTotal.value = 0;
  usagePage.value = 1;
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

.allowlist-hint {
  margin: 0 0 8px;
  font-size: 12px;
  color: var(--text-secondary);
  line-height: 1.5;
}

.allowlist-hint code {
  font-family: var(--font-mono);
  font-size: 11px;
  color: var(--text-accent);
  background: var(--color-accent-soft);
  padding: 1px 4px;
  border-radius: 4px;
}

.usage-list {
  max-height: 380px;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.usage-item {
  border: 1px solid var(--border-default);
  border-radius: var(--radius-sm);
  padding: 8px 10px;
}

.usage-item-top {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}

.usage-method {
  font-family: var(--font-mono);
  font-size: 12px;
  color: var(--text-accent);
  flex-shrink: 0;
}

.usage-route {
  font-family: var(--font-mono);
  font-size: 12px;
  color: var(--text-primary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.usage-item-meta {
  display: flex;
  justify-content: space-between;
  margin-top: 4px;
  font-size: 11px;
  color: var(--text-tertiary);
  font-family: var(--font-mono);
}

.usage-pager {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 12px;
  margin-top: 12px;
}

.usage-pager-info {
  font-size: 12px;
  color: var(--text-secondary);
}
</style>
