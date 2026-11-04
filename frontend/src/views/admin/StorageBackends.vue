<template>
  <div class="storage-backends-page">
    <div class="page-header">
      <h1>存储后端管理</h1>
      <p>管理 S3 / WebDAV / Google Drive 存储账号池与默认上传后端（仅超级管理员可见）</p>
    </div>

    <!-- 默认后端 + 凭据加密状态 -->
    <section class="card status-card" aria-label="存储配置">
      <div class="status-switches">
        <div class="status-switch">
          <div class="status-switch-text">
            <span class="status-switch-label">默认上传后端</span>
            <span class="status-switch-meta">仅影响新上传会话；在途任务按创建时冻结的后端继续</span>
          </div>
          <div class="default-backend-picker">
            <t-select
              v-model="defaultBackendDraft"
              :options="backendOptions"
              size="small"
              style="width: 180px"
            />
            <t-button size="small" :loading="defaultSaving" @click="saveDefaultBackend">保存</t-button>
          </div>
        </div>
        <div class="status-switch">
          <div class="status-switch-text">
            <span class="status-switch-label">Google Drive 授权</span>
            <span class="status-switch-meta">
              {{ overview?.gdriveOAuthConfigured ? 'OAuth Client 已配置' : '未配置 OAuth Client' }}
            </span>
          </div>
          <t-button size="small" variant="outline" @click="openGDriveWizard">添加 GDrive 账号</t-button>
        </div>
      </div>
      <t-alert
        v-if="overview && !overview.credentialAvailable"
        theme="warning"
        title="凭据加密不可用"
        message="未配置 STORAGE_ENCRYPTION_KEY（32 字节 base64/hex），无法创建或轮换存储账号。请在服务端 .env 配置后重启。"
      />
    </section>

    <!-- 总览卡区 -->
    <section class="overview-grid" aria-label="总览">
      <div class="stat-card">
        <h3>存储账号</h3>
        <div class="value">{{ accounts.length }}</div>
        <div class="stat-sub">
          S3 {{ countByType('s3') }} · WebDAV {{ countByType('webdav') }} · GDrive {{ countByType('gdrive') }}
        </div>
        <div class="stat-sub">正常 {{ countByStatus('active') }} · 降级 {{ countByStatus('degraded') }} · 停用 {{ countByStatus('disabled') }} · 撤销 {{ countByStatus('revoked') }}</div>
      </div>
      <div class="stat-card">
        <h3>GDrive 池剩余容量</h3>
        <div class="value">{{ formatBytes(gdriveRemainingBytes) }}</div>
        <div class="stat-sub">个人账号每个 15GB，写满自动换号；添加账号即扩容</div>
        <div class="stat-sub">已用 {{ formatBytes(gdriveUsedBytes) }} / 总 {{ formatBytes(gdriveTotalBytes) }}</div>
      </div>
      <div class="stat-card">
        <h3>在飞传输</h3>
        <div class="value">{{ totalInflight }}</div>
        <div class="stat-sub">冷却中 {{ coolingCount }} 个账号</div>
      </div>
      <div class="stat-card">
        <h3>最近失败</h3>
        <div class="value error-value">{{ latestFailure?.lastFailureCode || '无' }}</div>
        <div class="stat-sub error-summary">{{ latestFailure?.lastFailureSummary || '暂无错误记录' }}</div>
        <div class="stat-sub">{{ formatTime(latestFailure?.lastFailureAt) }}</div>
      </div>
    </section>

    <!-- 账号列表 -->
    <section class="card" aria-label="存储账号列表">
      <div class="section-header">
        <h3>存储账号</h3>
        <div class="section-actions">
          <t-select
            v-model="typeFilter"
            :options="typeFilterOptions"
            size="small"
            style="width: 140px"
            placeholder="全部类型"
            clearable
          />
          <t-button variant="outline" size="small" :loading="loading" @click="loadOverview">刷新</t-button>
          <t-button size="small" @click="openCreate">添加账号</t-button>
        </div>
      </div>

      <t-table
        :data="filteredAccounts"
        :columns="columns"
        row-key="id"
        size="small"
        :loading="loading"
        hover
      >
        <template #type="{ row }">
          <t-tag theme="primary" variant="light">{{ typeLabel(row.type) }}</t-tag>
        </template>
        <template #status="{ row }">
          <t-tag :theme="statusTheme(row.status)" variant="light">{{ statusLabel(row.status) }}</t-tag>
        </template>
        <template #enabled="{ row }">
          <t-switch
            :value="row.enabled"
            :disabled="row.status === 'revoked'"
            size="small"
            @change="(v: boolean) => toggleEnabled(row, Boolean(v))"
          />
        </template>
        <template #quota="{ row }">
          <div v-if="row.type === 'gdrive' && row.quotaTotalBytes" class="quota-cell">
            <t-progress
              :percentage="quotaPercentage(row)"
              :color="quotaPercentage(row) > 90 ? '#e34d59' : undefined"
              size="small"
            />
            <span class="quota-text">{{ formatBytes(row.quotaUsedBytes) }} / {{ formatBytes(row.quotaTotalBytes) }}</span>
          </div>
          <span v-else class="muted">—</span>
        </template>
        <template #health="{ row }">
          <div class="health-cell">
            <span>成功 {{ formatTime(row.lastSuccessAt) }}</span>
            <span v-if="row.lastFailureAt" class="error-summary">失败 {{ formatTime(row.lastFailureAt) }}（{{ row.lastFailureCode }}）</span>
          </div>
        </template>
        <template #operation="{ row }">
          <div class="row-actions">
            <t-button variant="text" size="small" :loading="rowBusy === row.id" @click="testAccount(row)">测试</t-button>
            <t-button variant="text" size="small" :disabled="row.status === 'revoked'" @click="openEdit(row)">编辑</t-button>
            <t-button variant="text" size="small" @click="openRotate(row)">轮换</t-button>
            <t-button v-if="row.type === 'gdrive'" variant="text" size="small" @click="refreshQuota(row)">配额</t-button>
            <t-button variant="text" size="small" theme="danger" :disabled="row.status === 'revoked'" @click="revokeAccount(row)">撤销</t-button>
          </div>
        </template>
      </t-table>
    </section>

    <!-- 创建/编辑对话框 -->
    <t-dialog
      v-model:visible="editorVisible"
      :header="editingId ? '编辑存储账号' : '添加存储账号'"
      width="640px"
      :confirm-btn="{ content: '保存', loading: saving }"
      @confirm="saveAccount"
    >
      <t-form label-align="top">
        <t-form-item v-if="!editingId" label="后端类型">
          <t-select v-model="form.type" :options="createTypeOptions" />
        </t-form-item>
        <t-form-item label="账号名称">
          <t-input v-model="form.name" placeholder="管理员可读名称（同类型下唯一）" />
        </t-form-item>

        <template v-if="form.type === 's3'">
          <t-form-item label="Endpoint（可选，MinIO/R2/OSS 自建端点）">
            <t-input v-model="form.s3.endpoint" placeholder="https://s3.example.com（留空走 AWS 官方）" />
          </t-form-item>
          <t-form-item label="Region">
            <t-input v-model="form.s3.region" placeholder="us-east-1 / auto" />
          </t-form-item>
          <t-form-item label="Bucket">
            <t-input v-model="form.s3.bucket" placeholder="存储桶名称" />
          </t-form-item>
          <t-form-item label="根前缀（可选）">
            <t-input v-model="form.s3.prefix" placeholder="bucket 内隔离目录，如 tgtc" />
          </t-form-item>
          <t-form-item label="Path-Style 寻址（MinIO 等通常需要）">
            <t-switch v-model="form.s3.forcePathStyle" />
          </t-form-item>
          <template v-if="!editingId">
            <t-form-item label="Access Key ID">
              <t-input v-model="form.credential.accessKeyId" type="password" autocomplete="off" />
            </t-form-item>
            <t-form-item label="Secret Access Key">
              <t-input v-model="form.credential.secretAccessKey" type="password" autocomplete="off" />
            </t-form-item>
          </template>
        </template>

        <template v-else-if="form.type === 'webdav'">
          <t-form-item label="WebDAV URL">
            <t-input v-model="form.webdav.url" placeholder="https://host/remote.php/dav/files/user/" />
          </t-form-item>
          <t-form-item label="存储子目录（可选）">
            <t-input v-model="form.webdav.rootPath" placeholder="tgtc" />
          </t-form-item>
          <template v-if="!editingId">
            <t-form-item label="用户名">
              <t-input v-model="form.credential.username" autocomplete="off" />
            </t-form-item>
            <t-form-item label="密码 / 应用专用密码">
              <t-input v-model="form.credential.password" type="password" autocomplete="off" />
            </t-form-item>
          </template>
        </template>

        <t-alert
          v-if="form.type === 'gdrive' && !editingId"
          theme="info"
          message="Google Drive 账号请通过「添加 GDrive 账号」授权向导创建（OAuth 授权，无需手动填写凭据）。"
        />

        <t-form-item label="调度权重">
          <t-input-number v-model="form.weight" :min="1" :max="100" />
        </t-form-item>
        <t-form-item label="每账号在飞上限">
          <t-input-number v-model="form.maxInflight" :min="1" :max="64" />
        </t-form-item>
        <t-form-item label="备注">
          <t-input v-model="form.note" placeholder="可选" />
        </t-form-item>
      </t-form>
    </t-dialog>

    <!-- 凭据轮换对话框 -->
    <t-dialog
      v-model:visible="rotateVisible"
      header="轮换凭据"
      width="520px"
      :confirm-btn="{ content: '轮换', loading: saving }"
      @confirm="saveRotate"
    >
      <t-alert v-if="rotateTarget?.type === 'gdrive'" theme="info" message="GDrive 凭据轮换即重新授权：请关闭本对话框后使用「添加 GDrive 账号」向导重新授权同一 Google 账号，再撤销旧账号行。" />
      <t-form v-else label-align="top">
        <template v-if="rotateTarget?.type === 's3'">
          <t-form-item label="新 Access Key ID">
            <t-input v-model="rotateForm.accessKeyId" type="password" autocomplete="off" />
          </t-form-item>
          <t-form-item label="新 Secret Access Key">
            <t-input v-model="rotateForm.secretAccessKey" type="password" autocomplete="off" />
          </t-form-item>
        </template>
        <template v-else-if="rotateTarget?.type === 'webdav'">
          <t-form-item label="用户名">
            <t-input v-model="rotateForm.username" autocomplete="off" />
          </t-form-item>
          <t-form-item label="新密码">
            <t-input v-model="rotateForm.password" type="password" autocomplete="off" />
          </t-form-item>
        </template>
      </t-form>
    </t-dialog>

    <!-- GDrive 授权向导 -->
    <t-dialog
      v-model:visible="gdriveVisible"
      header="添加 Google Drive 账号"
      width="680px"
      :footer="false"
    >
      <div class="gdrive-wizard">
        <t-alert
          theme="info"
          message="每个普通 Google 账号提供 15GB 免费空间。授权多个账号即可池化扩容：上传按剩余配额自动选号，写满自动换下一个账号。应用仅访问自己创建的文件（drive.file scope）。"
        />

        <!-- 步骤 1：OAuth Client -->
        <div class="wizard-step">
          <h4>1. 配置 OAuth Client{{ overview?.gdriveOAuthConfigured ? '（已配置）' : '' }}</h4>
          <p class="wizard-hint">
            在 Google Cloud Console 创建 OAuth 客户端（桌面/网页应用），登记回调地址（如 http://localhost），启用 Google Drive API。
          </p>
          <div class="wizard-row">
            <t-input v-model="gdrive.clientId" placeholder="Client ID" style="flex: 1" />
            <t-input v-model="gdrive.clientSecret" placeholder="Client Secret" type="password" style="flex: 1" />
            <t-button size="small" :loading="gdriveSaving" @click="saveOAuthClient">保存</t-button>
          </div>
        </div>

        <!-- 步骤 2：生成授权链接 -->
        <div class="wizard-step">
          <h4>2. 生成授权链接</h4>
          <div class="wizard-row">
            <t-input v-model="gdrive.redirectUri" placeholder="回调地址（须与 Console 登记一致）" style="flex: 1" />
            <t-input v-model="gdrive.name" placeholder="账号名称" style="width: 160px" />
            <t-button size="small" :loading="gdriveSaving" @click="buildAuthUrl">生成链接</t-button>
          </div>
          <div v-if="gdrive.authUrl" class="wizard-row">
            <t-input :value="gdrive.authUrl" readonly style="flex: 1" />
            <t-button size="small" variant="outline" @click="openAuthUrl">打开授权页</t-button>
          </div>
          <p class="wizard-hint">在浏览器完成授权后，从回调地址栏复制 code 参数值粘贴到下方。</p>
        </div>

        <!-- 步骤 3：提交授权码 -->
        <div class="wizard-step">
          <h4>3. 提交授权码</h4>
          <div class="wizard-row">
            <t-input v-model="gdrive.code" placeholder="粘贴授权码（code）" style="flex: 1" />
            <t-button size="small" theme="primary" :loading="gdriveSaving" @click="completeAuth">完成授权并入池</t-button>
          </div>
        </div>
      </div>
    </t-dialog>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue';
import { DialogPlugin } from 'tdesign-vue-next/es/dialog';
import MessagePlugin from '@/utils/message';
import { getErrorMessage } from '@/utils/error';
import {
  completeGDriveAuth,
  createStorageBackend,
  fetchGDriveAuthUrl,
  fetchStorageOverview,
  refreshStorageQuota,
  revokeStorageBackend,
  rotateStorageCredential,
  setDefaultStorageBackend,
  setGDriveOAuthClient,
  testStorageBackend,
  updateStorageBackend,
  type RemoteStorageBackendType,
  type StorageBackendType,
  type StorageBackendView,
  type StorageOverview,
} from '@/api/storage-backends';

const loading = ref(false);
const saving = ref(false);
const defaultSaving = ref(false);
const gdriveSaving = ref(false);
const rowBusy = ref<string | null>(null);
const overview = ref<StorageOverview | null>(null);
const typeFilter = ref<RemoteStorageBackendType | undefined>(undefined);
const defaultBackendDraft = ref<StorageBackendType>('telegram');

const accounts = computed(() => overview.value?.accounts ?? []);
const filteredAccounts = computed(() =>
  typeFilter.value ? accounts.value.filter((a) => a.type === typeFilter.value) : accounts.value,
);

const backendOptions = computed(() => {
  const available = overview.value?.availableBackends ?? ['telegram'];
  const labels: Record<StorageBackendType, string> = {
    telegram: 'Telegram',
    s3: 'S3 兼容',
    webdav: 'WebDAV',
    gdrive: 'Google Drive',
  };
  // 已配置但暂无可用账号的后端也允许选择（路由器会安全回退 telegram 并提示）
  const types = new Set<StorageBackendType>([...available, ...(overview.value?.driverTypes ?? [])]);
  return Array.from(types).map((type) => ({ label: labels[type], value: type }));
});

const typeFilterOptions = [
  { label: 'S3 兼容', value: 's3' },
  { label: 'WebDAV', value: 'webdav' },
  { label: 'Google Drive', value: 'gdrive' },
];
const createTypeOptions = [
  { label: 'S3 兼容（MinIO/R2/OSS/AWS）', value: 's3' },
  { label: 'WebDAV（Nextcloud/Alist/坚果云）', value: 'webdav' },
];

const columns = [
  { colKey: 'name', title: '名称', minWidth: 140 },
  { colKey: 'type', title: '类型', width: 110 },
  { colKey: 'status', title: '状态', width: 90 },
  { colKey: 'enabled', title: '启用', width: 70 },
  { colKey: 'weight', title: '权重', width: 70 },
  { colKey: 'quota', title: '配额', minWidth: 160 },
  { colKey: 'health', title: '健康', minWidth: 180 },
  { colKey: 'operation', title: '操作', width: 240, fixed: 'right' as const },
];

const gdriveAccounts = computed(() => accounts.value.filter((a) => a.type === 'gdrive' && a.status !== 'revoked'));
const gdriveTotalBytes = computed(() => gdriveAccounts.value.reduce((sum, a) => sum + (a.quotaTotalBytes ?? 0), 0));
const gdriveUsedBytes = computed(() => gdriveAccounts.value.reduce((sum, a) => sum + (a.quotaUsedBytes ?? 0), 0));
const gdriveRemainingBytes = computed(() => Math.max(0, gdriveTotalBytes.value - gdriveUsedBytes.value));
const totalInflight = computed(() => (overview.value?.scheduler ?? []).reduce((sum, s) => sum + s.inflight, 0));
const coolingCount = computed(() => (overview.value?.scheduler ?? []).filter((s) => s.cooldownRemainingMs > 0).length);
const latestFailure = computed(() => {
  const failed = accounts.value.filter((a) => a.lastFailureAt);
  failed.sort((a, b) => String(b.lastFailureAt).localeCompare(String(a.lastFailureAt)));
  return failed[0] ?? null;
});

function countByType(type: RemoteStorageBackendType): number {
  return accounts.value.filter((a) => a.type === type).length;
}
function countByStatus(status: string): number {
  return accounts.value.filter((a) => a.status === status).length;
}
function typeLabel(type: string): string {
  return ({ s3: 'S3', webdav: 'WebDAV', gdrive: 'GDrive' } as Record<string, string>)[type] ?? type;
}
function statusLabel(status: string): string {
  return ({ active: '正常', disabled: '停用', degraded: '降级', revoked: '已撤销', draining: '排空中' } as Record<string, string>)[status] ?? status;
}
function statusTheme(status: string): string {
  return ({ active: 'success', disabled: 'default', degraded: 'warning', revoked: 'danger', draining: 'warning' } as Record<string, string>)[status] ?? 'default';
}
function quotaPercentage(row: StorageBackendView): number {
  if (!row.quotaTotalBytes) return 0;
  return Math.min(100, Math.round(((row.quotaUsedBytes ?? 0) / row.quotaTotalBytes) * 100));
}
function formatBytes(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  if (value >= 1024 ** 3) return `${(value / 1024 ** 3).toFixed(2)} GB`;
  if (value >= 1024 ** 2) return `${(value / 1024 ** 2).toFixed(1)} MB`;
  if (value >= 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${value} B`;
}
function formatTime(value: string | null | undefined): string {
  if (!value) return '—';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '—' : date.toLocaleString();
}

async function loadOverview() {
  loading.value = true;
  try {
    overview.value = await fetchStorageOverview();
    defaultBackendDraft.value = overview.value.defaultBackend;
  } catch (error) {
    MessagePlugin.error(getErrorMessage(error));
  } finally {
    loading.value = false;
  }
}

async function saveDefaultBackend() {
  defaultSaving.value = true;
  try {
    const result = await setDefaultStorageBackend(defaultBackendDraft.value);
    MessagePlugin.success(result.message);
    await loadOverview();
  } catch (error) {
    MessagePlugin.error(getErrorMessage(error));
  } finally {
    defaultSaving.value = false;
  }
}

// ---------- 创建/编辑 ----------
const editorVisible = ref(false);
const editingId = ref<string | null>(null);
const form = reactive({
  type: 's3' as RemoteStorageBackendType,
  name: '',
  weight: 1,
  maxInflight: 8,
  note: '',
  s3: { endpoint: '', region: '', bucket: '', prefix: '', forcePathStyle: false },
  webdav: { url: '', rootPath: '' },
  credential: { accessKeyId: '', secretAccessKey: '', username: '', password: '' },
});

function resetForm() {
  form.type = 's3';
  form.name = '';
  form.weight = 1;
  form.maxInflight = 8;
  form.note = '';
  form.s3 = { endpoint: '', region: '', bucket: '', prefix: '', forcePathStyle: false };
  form.webdav = { url: '', rootPath: '' };
  form.credential = { accessKeyId: '', secretAccessKey: '', username: '', password: '' };
}

function openCreate() {
  editingId.value = null;
  resetForm();
  editorVisible.value = true;
}

function openEdit(row: StorageBackendView) {
  editingId.value = row.id;
  resetForm();
  form.type = row.type;
  form.name = row.name;
  form.weight = row.weight;
  form.maxInflight = row.maxInflight;
  form.note = row.note ?? '';
  const config = (row.config ?? {}) as Record<string, unknown>;
  if (row.type === 's3') {
    form.s3 = {
      endpoint: String(config.endpoint ?? ''),
      region: String(config.region ?? ''),
      bucket: String(config.bucket ?? ''),
      prefix: String(config.prefix ?? ''),
      forcePathStyle: Boolean(config.forcePathStyle),
    };
  } else if (row.type === 'webdav') {
    form.webdav = { url: String(config.url ?? ''), rootPath: String(config.rootPath ?? '') };
  }
  editorVisible.value = true;
}

function buildConfig(): Record<string, unknown> {
  if (form.type === 's3') {
    const config: Record<string, unknown> = { region: form.s3.region, bucket: form.s3.bucket };
    if (form.s3.endpoint) config.endpoint = form.s3.endpoint;
    if (form.s3.prefix) config.prefix = form.s3.prefix;
    config.forcePathStyle = form.s3.forcePathStyle;
    return config;
  }
  if (form.type === 'webdav') {
    const config: Record<string, unknown> = { url: form.webdav.url };
    if (form.webdav.rootPath) config.rootPath = form.webdav.rootPath;
    return config;
  }
  return {};
}

async function saveAccount() {
  if (form.type === 'gdrive' && !editingId.value) {
    MessagePlugin.warning('请使用「添加 GDrive 账号」授权向导');
    return;
  }
  saving.value = true;
  try {
    if (editingId.value) {
      const result = await updateStorageBackend(editingId.value, {
        name: form.name,
        config: buildConfig(),
        weight: form.weight,
        maxInflight: form.maxInflight,
        note: form.note,
      });
      MessagePlugin.success(result.message);
    } else {
      const credential = form.type === 's3'
        ? { accessKeyId: form.credential.accessKeyId, secretAccessKey: form.credential.secretAccessKey }
        : { username: form.credential.username, password: form.credential.password };
      const result = await createStorageBackend({
        type: form.type,
        name: form.name,
        config: buildConfig(),
        credential,
        weight: form.weight,
        maxInflight: form.maxInflight,
        note: form.note,
      });
      MessagePlugin.success(result.message);
    }
    editorVisible.value = false;
    await loadOverview();
  } catch (error) {
    MessagePlugin.error(getErrorMessage(error));
  } finally {
    saving.value = false;
  }
}

async function toggleEnabled(row: StorageBackendView, enabled: boolean) {
  try {
    await updateStorageBackend(row.id, { enabled });
    MessagePlugin.success(enabled ? '账号已启用' : '账号已停用（不中断在途传输）');
    await loadOverview();
  } catch (error) {
    MessagePlugin.error(getErrorMessage(error));
  }
}

async function testAccount(row: StorageBackendView) {
  rowBusy.value = row.id;
  try {
    const result = await testStorageBackend(row.id);
    if (result.probe.ok) {
      MessagePlugin.success(`连通性测试通过（${result.probe.latencyMs ?? '—'}ms）`);
    } else {
      MessagePlugin.error(`测试失败：${result.probe.error || '未知错误'}`);
    }
    await loadOverview();
  } catch (error) {
    MessagePlugin.error(getErrorMessage(error));
  } finally {
    rowBusy.value = null;
  }
}

async function refreshQuota(row: StorageBackendView) {
  rowBusy.value = row.id;
  try {
    const result = await refreshStorageQuota(row.id);
    MessagePlugin.success(result.message);
    await loadOverview();
  } catch (error) {
    MessagePlugin.error(getErrorMessage(error));
  } finally {
    rowBusy.value = null;
  }
}

function revokeAccount(row: StorageBackendView) {
  const dialog = DialogPlugin.confirm({
    header: '撤销存储账号',
    body: `撤销「${row.name}」后将清空凭据并停止参与新任务；该账号上的存量文件将不可下载（远端对象不会被删除）。确认撤销？`,
    theme: 'warning',
    onConfirm: async () => {
      try {
        const result = await revokeStorageBackend(row.id);
        MessagePlugin.success(result.message);
        await loadOverview();
      } catch (error) {
        MessagePlugin.error(getErrorMessage(error));
      } finally {
        dialog.destroy();
      }
    },
  });
}

// ---------- 凭据轮换 ----------
const rotateVisible = ref(false);
const rotateTarget = ref<StorageBackendView | null>(null);
const rotateForm = reactive({ accessKeyId: '', secretAccessKey: '', username: '', password: '' });

function openRotate(row: StorageBackendView) {
  rotateTarget.value = row;
  rotateForm.accessKeyId = '';
  rotateForm.secretAccessKey = '';
  rotateForm.username = '';
  rotateForm.password = '';
  rotateVisible.value = true;
}

async function saveRotate() {
  if (!rotateTarget.value || rotateTarget.value.type === 'gdrive') {
    rotateVisible.value = false;
    return;
  }
  saving.value = true;
  try {
    const credential = rotateTarget.value.type === 's3'
      ? { accessKeyId: rotateForm.accessKeyId, secretAccessKey: rotateForm.secretAccessKey }
      : { username: rotateForm.username, password: rotateForm.password };
    const result = await rotateStorageCredential(rotateTarget.value.id, credential);
    MessagePlugin.success(result.message);
    rotateVisible.value = false;
    await loadOverview();
  } catch (error) {
    MessagePlugin.error(getErrorMessage(error));
  } finally {
    saving.value = false;
  }
}

// ---------- GDrive 授权向导 ----------
const gdriveVisible = ref(false);
const gdrive = reactive({ clientId: '', clientSecret: '', redirectUri: '', name: '', code: '', authUrl: '' });

function openGDriveWizard() {
  gdrive.code = '';
  gdrive.authUrl = '';
  gdriveVisible.value = true;
}

async function saveOAuthClient() {
  gdriveSaving.value = true;
  try {
    const result = await setGDriveOAuthClient(gdrive.clientId, gdrive.clientSecret);
    MessagePlugin.success(result.message);
    gdrive.clientSecret = '';
    await loadOverview();
  } catch (error) {
    MessagePlugin.error(getErrorMessage(error));
  } finally {
    gdriveSaving.value = false;
  }
}

async function buildAuthUrl() {
  gdriveSaving.value = true;
  try {
    const result = await fetchGDriveAuthUrl(gdrive.redirectUri);
    gdrive.authUrl = result.url;
  } catch (error) {
    MessagePlugin.error(getErrorMessage(error));
  } finally {
    gdriveSaving.value = false;
  }
}

function openAuthUrl() {
  window.open(gdrive.authUrl, '_blank', 'noopener');
}

async function completeAuth() {
  gdriveSaving.value = true;
  try {
    const result = await completeGDriveAuth({
      code: gdrive.code,
      redirectUri: gdrive.redirectUri,
      name: gdrive.name,
    });
    MessagePlugin.success(result.message);
    gdriveVisible.value = false;
    await loadOverview();
  } catch (error) {
    MessagePlugin.error(getErrorMessage(error));
  } finally {
    gdriveSaving.value = false;
  }
}

onMounted(loadOverview);
</script>

<style scoped>
.storage-backends-page {
  display: flex;
  flex-direction: column;
  gap: 16px;
}
.page-header h1 {
  margin: 0 0 4px;
  font-size: 22px;
}
.page-header p {
  margin: 0;
  color: var(--td-text-color-secondary, #666);
  font-size: 13px;
}
.card {
  background: var(--td-bg-color-container, #fff);
  border-radius: 8px;
  padding: 16px;
  border: 1px solid var(--td-border-level-1-color, #e7e7e7);
}
.status-switches {
  display: flex;
  flex-wrap: wrap;
  gap: 24px;
  margin-bottom: 12px;
}
.status-switch {
  display: flex;
  align-items: center;
  gap: 12px;
}
.status-switch-text {
  display: flex;
  flex-direction: column;
}
.status-switch-label {
  font-weight: 600;
  font-size: 14px;
}
.status-switch-meta {
  font-size: 12px;
  color: var(--td-text-color-secondary, #888);
}
.default-backend-picker {
  display: flex;
  gap: 8px;
  align-items: center;
}
.overview-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
  gap: 12px;
}
.stat-card {
  background: var(--td-bg-color-container, #fff);
  border-radius: 8px;
  padding: 14px 16px;
  border: 1px solid var(--td-border-level-1-color, #e7e7e7);
}
.stat-card h3 {
  margin: 0 0 6px;
  font-size: 13px;
  color: var(--td-text-color-secondary, #666);
  font-weight: 500;
}
.stat-card .value {
  font-size: 24px;
  font-weight: 700;
}
.stat-card .error-value {
  font-size: 16px;
  color: var(--td-error-color, #e34d59);
}
.stat-sub {
  font-size: 12px;
  color: var(--td-text-color-secondary, #888);
  margin-top: 4px;
}
.error-summary {
  color: var(--td-error-color, #e34d59);
}
.section-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 12px;
  flex-wrap: wrap;
  gap: 8px;
}
.section-header h3 {
  margin: 0;
  font-size: 16px;
}
.section-actions {
  display: flex;
  gap: 8px;
  align-items: center;
}
.quota-cell {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 140px;
}
.quota-text {
  font-size: 12px;
  color: var(--td-text-color-secondary, #888);
}
.health-cell {
  display: flex;
  flex-direction: column;
  font-size: 12px;
  gap: 2px;
}
.row-actions {
  display: flex;
  flex-wrap: wrap;
}
.muted {
  color: var(--td-text-color-placeholder, #bbb);
}
.gdrive-wizard {
  display: flex;
  flex-direction: column;
  gap: 16px;
}
.wizard-step h4 {
  margin: 0 0 6px;
  font-size: 14px;
}
.wizard-hint {
  margin: 4px 0 8px;
  font-size: 12px;
  color: var(--td-text-color-secondary, #888);
}
.wizard-row {
  display: flex;
  gap: 8px;
  align-items: center;
  margin-bottom: 8px;
  flex-wrap: wrap;
}
</style>