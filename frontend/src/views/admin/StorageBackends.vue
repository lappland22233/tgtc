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
            <span class="status-switch-label">Google Drive 授权状态</span>
            <span class="status-switch-meta">
              {{ overview?.gdriveOAuthConfigured ? 'OAuth 客户端已就绪（点击设置查看或修改）' : '未配置 OAuth 客户端' }}
            </span>
          </div>
          <div class="status-switch-btns">
            <t-button size="small" variant="outline" @click="openOAuthClientDialog">OAuth 客户端设置</t-button>
            <t-button size="small" theme="primary" @click="openGDriveWizard()">添加 GDrive 账号</t-button>
          </div>
        </div>
        <div class="status-switch">
          <div class="status-switch-text">
            <span class="status-switch-label">Google 缓存模式 (免本地硬盘)</span>
            <span class="status-switch-meta">
              主存储为 TG 时异步镜像至 Google 账号池，客户端下载直链中转，零硬盘缓存
            </span>
          </div>
          <div class="status-switch-control">
            <t-switch
              v-model="gdriveCacheModeDraft"
              :loading="gdriveCacheModeSaving"
              @change="onGDriveCacheModeChange"
            />
          </div>
        </div>
        <div class="status-switch">
          <div class="status-switch-text">
            <span class="status-switch-label">GDrive 分块上传大小</span>
            <span class="status-switch-meta">
              单块分片体积，增大可减少网络往返并大幅提升上传速度（推荐 16MB 或 32MB）
            </span>
          </div>
          <div class="chunk-size-picker">
            <t-select
              v-model="gdriveChunkSizeDraft"
              :options="chunkSizeOptions"
              size="small"
              style="width: 170px"
            />
            <t-button size="small" :loading="chunkSizeSaving" @click="saveGDriveChunkSize">保存</t-button>
          </div>
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
          <t-checkbox v-model="showRevoked">显示已撤销账号（{{ revokedAccountCount }}）</t-checkbox>
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
        <template #name="{ row }">
          <div class="name-cell">
            <span class="account-name">{{ row.name }}</span>
            <div v-if="row.type === 'gdrive' && (row.config as any)?.email" class="account-email">
              {{ (row.config as any).email }}
            </div>
          </div>
        </template>
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
            <t-button
              variant="text"
              size="small"
              :theme="row.type === 'gdrive' ? 'primary' : 'default'"
              @click="openRotate(row)"
            >
              {{ row.type === 'gdrive' ? '重新授权' : '轮换' }}
            </t-button>
            <t-button v-if="row.type === 'gdrive'" variant="text" size="small" :loading="rowBusy === row.id" @click="refreshQuota(row)">配额</t-button>
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
      width="560px"
      :confirm-btn="{ content: '完成轮换', loading: saving }"
      @confirm="saveRotate"
    >
      <t-alert v-if="rotateTarget?.type === 'gdrive'" theme="info" message="继续后会为当前账号重新授权并更新凭据；请使用原 Google 账号，现有文件会继续引用此账号。" />
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
      :header="gdrive.accountId ? '重新授权 Google Drive 账号' : '添加 Google Drive 账号'"
      width="680px"
      :footer="false"
      @close="cancelOAuth"
    >
      <div class="gdrive-wizard">
        <t-alert
          theme="info"
          :message="gdrive.accountId
            ? '请使用原 Google 账号重新授权；凭据将更新到当前账号，现有文件引用保持不变。'
            : '每个普通 Google 账号提供 15GB 免费空间。授权多个账号即可池化扩容：上传按剩余配额自动选号，写满自动换下一个账号。应用仅访问自己创建的文件（drive.file scope）。'"
        />

        <!-- 步骤 1：OAuth Client 配置 -->
        <div class="wizard-card" :class="{ 'is-collapsed': overview?.gdriveOAuthConfigured && !showClientConfig }">
          <div class="wizard-card-header">
            <div class="wizard-card-title">
              <span class="step-num">1</span>
              <span class="step-title">Google OAuth 客户端配置</span>
              <t-tag v-if="overview?.gdriveOAuthConfigured" theme="success" variant="light" size="small">已配置</t-tag>
              <t-tag v-else theme="warning" variant="light" size="small">未配置</t-tag>
            </div>
            <t-button
              v-if="overview?.gdriveOAuthConfigured"
              variant="text"
              size="small"
              theme="primary"
              @click="showClientConfig = !showClientConfig"
            >
              {{ showClientConfig ? '收起配置' : '修改配置' }}
            </t-button>
          </div>

          <div v-show="!overview?.gdriveOAuthConfigured || showClientConfig" class="wizard-card-body">
            <div class="redirect-uri-box">
              <div class="redirect-uri-header">
                <span class="redirect-uri-label">已获授权的重定向 URI（在 Google Console 登记）</span>
                <t-button variant="text" size="small" theme="primary" @click="copyRedirectUri">
                  复制地址
                </t-button>
              </div>
              <t-input :value="gdrive.redirectUri" readonly size="small" />
              <p class="wizard-hint">
                在 Google Cloud Console 创建 OAuth 客户端（Web 应用程序），将上方地址添加到「已获授权的重定向 URI」，并启用 Google Drive API。
              </p>
            </div>

            <div class="wizard-row">
              <t-input v-model="gdrive.clientId" placeholder="Client ID" style="flex: 1" />
              <t-input v-model="gdrive.clientSecret" placeholder="Client Secret" type="password" style="flex: 1" />
              <t-button size="small" :loading="gdriveSaving" @click="saveOAuthClient">保存配置</t-button>
            </div>
          </div>
        </div>

        <!-- 步骤 2：账号授权（核心自动化流程） -->
        <div class="wizard-card">
          <div class="wizard-card-header">
            <div class="wizard-card-title">
              <span class="step-num">2</span>
              <span class="step-title">{{ gdrive.accountId ? '重新授权凭据' : '一键授权添加账号' }}</span>
            </div>
          </div>

          <div class="wizard-card-body">
            <div class="name-row">
              <label class="form-label">账号名称</label>
              <t-input
                v-if="!gdrive.accountId"
                v-model="gdrive.name"
                placeholder="留空自动使用 Google 账号邮箱命名"
                style="flex: 1"
              />
              <span v-else class="existing-name">{{ gdrive.name }}</span>
            </div>

            <p class="wizard-hint">
              在 Google 授权页勾选允许此应用访问 Google 云端硬盘文件的权限，再点击继续。如果上次漏选，请重新发起授权。
            </p>
            <div class="auth-action-area">
              <div v-if="authStatus === 'authorizing' || authStatus === 'exchanging'" class="auth-status-box">
                <div class="auth-spinner" />
                <div class="auth-status-info">
                  <div class="auth-status-main">{{ authStatusMessage }}</div>
                  <div class="auth-status-sub">
                    若未自动弹出窗口，<a href="javascript:void(0)" class="link-btn" @click="openAuthUrl">点击此处手动打开</a>
                  </div>
                </div>
              </div>

              <div v-else class="auth-btn-area">
                <t-button
                  theme="primary"
                  size="large"
                  :disabled="!overview?.gdriveOAuthConfigured"
                  :loading="gdriveSaving"
                  block
                  @click="startOAuth"
                >
                  {{ gdrive.accountId ? '一键重新授权当前账号' : '一键连接 Google 账号' }}
                </t-button>
                <div v-if="!overview?.gdriveOAuthConfigured" class="disabled-tip">
                  请先在步骤 1 中保存 OAuth Client 配置
                </div>
              </div>
            </div>

            <!-- 手动模式备用折叠入口 -->
            <div class="fallback-accordion">
              <div class="fallback-toggle" @click="showManualMode = !showManualMode">
                <span>{{ showManualMode ? '▼ 收起手动备用模式' : '▶ 遇到问题？使用手动粘贴授权码' }}</span>
              </div>

              <div v-show="showManualMode" class="fallback-body">
                <div class="wizard-row">
                  <t-input
                    v-model="gdrive.redirectUri"
                    placeholder="回调地址（默认自动填充当前站点回调）"
                    style="flex: 1"
                    size="small"
                  />
                  <t-button size="small" variant="outline" :loading="gdriveSaving" @click="buildManualAuthUrl">
                    生成链接
                  </t-button>
                </div>
                <div v-if="gdrive.authUrl" class="wizard-row">
                  <t-input :value="gdrive.authUrl" readonly size="small" style="flex: 1" />
                  <t-button size="small" variant="outline" @click="openAuthUrl">打开授权页</t-button>
                </div>
                <div class="wizard-row">
                  <t-input
                    v-model="gdrive.code"
                    placeholder="粘贴授权码（code）或重定向后的完整地址"
                    style="flex: 1"
                    @change="onManualCodeChange"
                  />
                  <t-button
                    size="small"
                    theme="primary"
                    :loading="gdriveSaving"
                    :disabled="!gdrive.code || !currentNonce || authStatus === 'exchanging'"
                    @click="completeAuth()"
                  >
                    提交入池
                  </t-button>
                </div>
                <p class="wizard-hint">
                  提示：支持直接将浏览器地址栏中的完整重定向 URL（如 http://localhost/?code=...）直接粘贴到输入框中，系统将自动解析真正的授权码。
                </p>
              </div>
            </div>
          </div>
        </div>
      </div>
    </t-dialog>

    <!-- Google OAuth 客户端与凭据配置专属对话框 -->
    <t-dialog
      v-model:visible="oauthClientModalVisible"
      header="Google Drive OAuth 客户端配置"
      width="620px"
      :footer="false"
    >
      <div class="oauth-client-dialog">
        <t-alert
          theme="info"
          message="配置在 Google Cloud Console 创建的 OAuth 2.0 Web 应用程序客户端（Client ID 与 Client Secret）。此凭据用于为个人 Google Drive 账号签发离线访问令牌。"
          style="margin-bottom: 16px;"
        />

        <div class="redirect-uri-box">
          <div class="redirect-uri-header">
            <span class="redirect-uri-label">已获授权的重定向 URI（在 Google Console 登记）</span>
            <t-button variant="text" size="small" theme="primary" @click="copyRedirectUri">
              复制地址
            </t-button>
          </div>
          <t-input :value="gdrive.redirectUri" readonly size="small" />
          <p class="wizard-hint">
            在 Google Cloud Console 创建 OAuth 客户端（Web 应用程序），将上方地址添加到「已获授权的重定向 URI」，并启用 Google Drive API。
          </p>
        </div>

        <t-form label-align="top">
          <t-form-item label="Client ID">
            <t-input v-model="gdrive.clientId" placeholder="例如：xxxx.apps.googleusercontent.com" />
          </t-form-item>
          <t-form-item label="Client Secret">
            <t-input
              v-model="gdrive.clientSecret"
              type="password"
              :placeholder="overview?.gdriveOAuthConfigured ? '已加密配置（留空保持不变）' : '请输入 Client Secret'"
              autocomplete="new-password"
            />
            <div class="wizard-hint">密钥在服务端使用 AES-256-GCM 加密落库，绝不在接口回显。</div>
          </t-form-item>
          <t-form-item label="默认重定向地址（可选）">
            <t-input v-model="gdrive.redirectUri" placeholder="默认使用当前站点的回调地址" />
          </t-form-item>
        </t-form>

        <div class="dialog-footer-actions">
          <t-button
            v-if="overview?.gdriveOAuthConfigured"
            theme="danger"
            variant="outline"
            :loading="gdriveSaving"
            @click="handleClearOAuthClient"
          >
            清空配置
          </t-button>
          <div style="flex: 1;" />
          <t-button variant="outline" @click="oauthClientModalVisible = false">取消</t-button>
          <t-button theme="primary" :loading="gdriveSaving" @click="saveOAuthClientFromDialog">
            保存配置
          </t-button>
        </div>
      </div>
    </t-dialog>
  </div>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import { DialogPlugin } from 'tdesign-vue-next/es/dialog';
import MessagePlugin from '@/utils/message';
import { getErrorMessage } from '@/utils/error';
import {
  clearGDriveOAuthClient,
  completeGDriveAuth,
  createStorageBackend,
  fetchGDriveAuthUrl,
  fetchGDriveOAuthClient,
  fetchStorageOverview,
  refreshStorageQuota,
  revokeStorageBackend,
  rotateStorageCredential,
  setDefaultStorageBackend,
  setGDriveOAuthClient,
  testStorageBackend,
  updateStorageBackend,
  updateStorageSettings,
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
const showRevoked = ref(false);
const defaultBackendDraft = ref<StorageBackendType>('telegram');
const gdriveCacheModeDraft = ref(false);
const gdriveCacheModeSaving = ref(false);
const gdriveChunkSizeDraft = ref(16);
const chunkSizeSaving = ref(false);

const chunkSizeOptions = [
  { label: '8 MB (低内存/保守)', value: 8 },
  { label: '16 MB (推荐标准)', value: 16 },
  { label: '32 MB (高速宽带推荐)', value: 32 },
  { label: '64 MB (超大吞吐)', value: 64 },
];

const accounts = computed(() => overview.value?.accounts ?? []);
const accountsOfSelectedType = computed(() =>
  typeFilter.value ? accounts.value.filter((a) => a.type === typeFilter.value) : accounts.value,
);
const revokedAccountCount = computed(() => accountsOfSelectedType.value.filter((a) => a.status === 'revoked').length);
const filteredAccounts = computed(() => showRevoked.value
  ? accountsOfSelectedType.value
  : accountsOfSelectedType.value.filter((a) => a.status !== 'revoked'));

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

let latestOverviewRequest = 0;
async function loadOverview() {
  const request = ++latestOverviewRequest;
  loading.value = true;
  try {
    const result = await fetchStorageOverview();
    if (request !== latestOverviewRequest) return;
    overview.value = result;
    defaultBackendDraft.value = overview.value.defaultBackend;
    gdriveCacheModeDraft.value = Boolean(overview.value.gdriveCacheMode);
    gdriveChunkSizeDraft.value = overview.value.gdriveChunkSizeMb ?? 16;
  } catch (error) {
    if (request === latestOverviewRequest) MessagePlugin.error(getErrorMessage(error));
  } finally {
    if (request === latestOverviewRequest) loading.value = false;
  }
}

async function saveDefaultBackend() {
  if (defaultSaving.value) return;
  defaultSaving.value = true;
  try {
    const result = await setDefaultStorageBackend(defaultBackendDraft.value);
    MessagePlugin.success(result.message || '默认存储后端已更新');
    await loadOverview();
  } catch (error) {
    MessagePlugin.error(getErrorMessage(error));
  } finally {
    defaultSaving.value = false;
  }
}

async function onGDriveCacheModeChange(val: boolean) {
  if (gdriveCacheModeSaving.value) return;
  gdriveCacheModeSaving.value = true;
  try {
    const res = await updateStorageSettings({ gdriveCacheMode: val });
    gdriveCacheModeDraft.value = res.gdriveCacheMode;
    MessagePlugin.success(res.message || 'Google 缓存模式已更新');
    if (overview.value) {
      overview.value.gdriveCacheMode = res.gdriveCacheMode;
    }
  } catch (error) {
    gdriveCacheModeDraft.value = !val;
    MessagePlugin.error(getErrorMessage(error));
  } finally {
    gdriveCacheModeSaving.value = false;
  }
}

async function saveGDriveChunkSize() {
  if (chunkSizeSaving.value) return;
  chunkSizeSaving.value = true;
  try {
    const res = await updateStorageSettings({ gdriveChunkSizeMb: gdriveChunkSizeDraft.value });
    MessagePlugin.success(res.message || 'GDrive 分块大小已更新');
    if (overview.value) {
      overview.value.gdriveChunkSizeMb = res.gdriveChunkSizeMb;
    }
  } catch (error) {
    MessagePlugin.error(getErrorMessage(error));
  } finally {
    chunkSizeSaving.value = false;
  }
}

// ---------- 创建/编辑 ----------
const editorVisible = ref(false);
const editingId = ref<string | null>(null);
const form = ref({
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
  form.value.type = 's3';
  form.value.name = '';
  form.value.weight = 1;
  form.value.maxInflight = 8;
  form.value.note = '';
  form.value.s3 = { endpoint: '', region: '', bucket: '', prefix: '', forcePathStyle: false };
  form.value.webdav = { url: '', rootPath: '' };
  form.value.credential = { accessKeyId: '', secretAccessKey: '', username: '', password: '' };
}

function openCreate() {
  editingId.value = null;
  resetForm();
  editorVisible.value = true;
}

function openEdit(row: StorageBackendView) {
  editingId.value = row.id;
  resetForm();
  form.value.type = row.type;
  form.value.name = row.name;
  form.value.weight = row.weight;
  form.value.maxInflight = row.maxInflight;
  form.value.note = row.note ?? '';
  const config = (row.config ?? {}) as Record<string, unknown>;
  if (row.type === 's3') {
    form.value.s3 = {
      endpoint: String(config.endpoint ?? ''),
      region: String(config.region ?? ''),
      bucket: String(config.bucket ?? ''),
      prefix: String(config.prefix ?? ''),
      forcePathStyle: Boolean(config.forcePathStyle),
    };
  } else if (row.type === 'webdav') {
    form.value.webdav = { url: String(config.url ?? ''), rootPath: String(config.rootPath ?? '') };
  }
  editorVisible.value = true;
}

function buildConfig(): Record<string, unknown> {
  if (form.value.type === 's3') {
    const config: Record<string, unknown> = { region: form.value.s3.region, bucket: form.value.s3.bucket };
    if (form.value.s3.endpoint) config.endpoint = form.value.s3.endpoint;
    if (form.value.s3.prefix) config.prefix = form.value.s3.prefix;
    config.forcePathStyle = form.value.s3.forcePathStyle;
    return config;
  }
  if (form.value.type === 'webdav') {
    const config: Record<string, unknown> = { url: form.value.webdav.url };
    if (form.value.webdav.rootPath) config.rootPath = form.value.webdav.rootPath;
    return config;
  }
  return {};
}

async function saveAccount() {
  if (form.value.type === 'gdrive' && !editingId.value) {
    MessagePlugin.warning('请使用「添加 GDrive 账号」授权向导');
    return;
  }
  saving.value = true;
  try {
    if (editingId.value) {
      const result = await updateStorageBackend(editingId.value, {
        name: form.value.name,
        ...(form.value.type === 'gdrive' ? {} : { config: buildConfig() }),
        weight: form.value.weight,
        maxInflight: form.value.maxInflight,
        note: form.value.note,
      });
      MessagePlugin.success(result.message);
    } else {
      const credential = form.value.type === 's3'
        ? { accessKeyId: form.value.credential.accessKeyId, secretAccessKey: form.value.credential.secretAccessKey }
        : { username: form.value.credential.username, password: form.value.credential.password };
      const result = await createStorageBackend({
        type: form.value.type,
        name: form.value.name,
        config: buildConfig(),
        credential,
        weight: form.value.weight,
        maxInflight: form.value.maxInflight,
        note: form.value.note,
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
        const account = accounts.value.find((item) => item.id === row.id);
        if (account) Object.assign(account, result.account);
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
const rotateForm = ref({ accessKeyId: '', secretAccessKey: '', username: '', password: '' });

function openRotate(row: StorageBackendView) {
  rotateTarget.value = row;
  rotateForm.value.accessKeyId = '';
  rotateForm.value.secretAccessKey = '';
  rotateForm.value.username = '';
  rotateForm.value.password = '';
  rotateVisible.value = true;
}

async function saveRotate() {
  if (!rotateTarget.value) return;
  if (rotateTarget.value.type === 'gdrive') {
    const target = rotateTarget.value;
    rotateVisible.value = false;
    openGDriveWizard(target);
    return;
  }
  saving.value = true;
  try {
    const credential = rotateTarget.value.type === 's3'
      ? { accessKeyId: rotateForm.value.accessKeyId, secretAccessKey: rotateForm.value.secretAccessKey }
      : { username: rotateForm.value.username, password: rotateForm.value.password };
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
const oauthClientModalVisible = ref(false);
const showClientConfig = ref(false);
const showManualMode = ref(false);
const authStatus = ref<'idle' | 'authorizing' | 'exchanging' | 'success'>('idle');
const authStatusMessage = ref('');
const currentNonce = ref('');
let oauthGeneration = 0;
let authorizedRedirect = '';
const popupRef = ref<Window | null>(null);

let bcChannel: BroadcastChannel | null = null;

const gdrive = ref({
  accountId: null as string | null,
  clientId: '',
  clientSecret: '',
  redirectUri: '',
  name: '',
  code: '',
  authUrl: '',
});

function getDefaultRedirectUri(): string {
  return `${window.location.origin}/admin/storage-backends/gdrive-callback`;
}

function extractOAuthCode(input: string): string {
  const trimmed = input.trim();
  if (trimmed.includes('code=')) {
    try {
      const url = trimmed.startsWith('http://') || trimmed.startsWith('https://')
        ? new URL(trimmed)
        : new URL(`http://localhost/?${trimmed}`);
      const code = url.searchParams.get('code');
      if (code) return code.trim();
    } catch {
      const match = trimmed.match(/[?&]code=([^&#]+)/);
      if (match && match[1]) return decodeURIComponent(match[1]).trim();
    }
  }
  return trimmed;
}

async function copyRedirectUri() {
  const uri = gdrive.value.redirectUri || getDefaultRedirectUri();
  try {
    await navigator.clipboard.writeText(uri);
    MessagePlugin.success('已复制回调地址到剪贴板，请在 Google Cloud Console 中填入');
  } catch {
    MessagePlugin.warning('复制失败，请手动选中复制');
  }
}

async function openOAuthClientDialog() {
  gdrive.value.clientSecret = '';
  try {
    const client = await fetchGDriveOAuthClient();
    if (client.clientId) {
      gdrive.value.clientId = client.clientId;
    }
    gdrive.value.redirectUri = client.redirectUri || getDefaultRedirectUri();
  } catch {
    gdrive.value.redirectUri = getDefaultRedirectUri();
  }
  oauthClientModalVisible.value = true;
}

async function saveOAuthClientFromDialog() {
  if (!gdrive.value.clientId?.trim()) {
    MessagePlugin.warning('Client ID 不能为空');
    return;
  }
  gdriveSaving.value = true;
  try {
    const result = await setGDriveOAuthClient(
      gdrive.value.clientId,
      gdrive.value.clientSecret || undefined,
      gdrive.value.redirectUri,
    );
    MessagePlugin.success(result.message);
    gdrive.value.clientSecret = '';
    oauthClientModalVisible.value = false;
    await loadOverview();
  } catch (error) {
    MessagePlugin.error(getErrorMessage(error));
  } finally {
    gdriveSaving.value = false;
  }
}

function handleClearOAuthClient() {
  const dialog = DialogPlugin.confirm({
    header: '清空 Google OAuth 客户端配置',
    body: '清空 OAuth Client 配置后将无法添加新账号或使用依赖该 Client 的已入池 Google Drive 账号。若系统内已有未撤销的 GDrive 账号，必须先删除/撤销相关账号后方可清空。确认清空？',
    theme: 'warning',
    onConfirm: async () => {
      gdriveSaving.value = true;
      try {
        const result = await clearGDriveOAuthClient();
        MessagePlugin.success(result.message);
        gdrive.value.clientId = '';
        gdrive.value.clientSecret = '';
        oauthClientModalVisible.value = false;
        await loadOverview();
      } catch (error) {
        MessagePlugin.error(getErrorMessage(error));
      } finally {
        gdriveSaving.value = false;
        dialog.destroy();
      }
    },
  });
}

async function openGDriveWizard(account?: StorageBackendView) {
  cancelOAuth();
  gdrive.value.accountId = account?.id ?? null;
  gdrive.value.name = account?.name ?? '';
  gdrive.value.code = '';
  gdrive.value.authUrl = '';
  authStatus.value = 'idle';
  authStatusMessage.value = '';
  showManualMode.value = false;

  try {
    const client = await fetchGDriveOAuthClient();
    if (client.clientId) {
      gdrive.value.clientId = client.clientId;
    }
    gdrive.value.redirectUri = client.redirectUri || getDefaultRedirectUri();
    showClientConfig.value = !client.configured;
  } catch {
    gdrive.value.redirectUri = getDefaultRedirectUri();
    showClientConfig.value = true;
  }
  gdriveVisible.value = true;
}

async function saveOAuthClient() {
  gdriveSaving.value = true;
  try {
    const result = await setGDriveOAuthClient(gdrive.value.clientId, gdrive.value.clientSecret, gdrive.value.redirectUri);
    MessagePlugin.success(result.message);
    gdrive.value.clientSecret = '';
    showClientConfig.value = false;
    await loadOverview();
  } catch (error) {
    MessagePlugin.error(getErrorMessage(error));
  } finally {
    gdriveSaving.value = false;
  }
}

function setupOAuthListeners() {
  cleanupOAuthListeners();

  // 1. postMessage 监听（弹窗直接跨窗口通讯）
  window.addEventListener('message', onMessageReceived);

  // 2. BroadcastChannel 监听（跨标签页/跨窗口即时广播）
  try {
    bcChannel = new BroadcastChannel('tgtc_gdrive_oauth_channel');
    bcChannel.onmessage = (event) => {
      if (event.data?.type === 'TGTC_GDRIVE_OAUTH_RESULT') {
        handleOAuthCallbackResult(event.data);
      }
    };
  } catch (e) {
    console.warn('BroadcastChannel not supported:', e);
  }

  // 3. localStorage 事件监听（环境兼容兜底）
  window.addEventListener('storage', onStorageEvent);
}

let popupPollTimer: ReturnType<typeof setInterval> | null = null;
let popupTimeoutTimer: ReturnType<typeof setTimeout> | null = null;

function stopPopupWatcher() {
  if (popupPollTimer) {
    clearInterval(popupPollTimer);
    popupPollTimer = null;
  }
  if (popupTimeoutTimer) {
    clearTimeout(popupTimeoutTimer);
    popupTimeoutTimer = null;
  }
}

function startPopupWatcher(popup: Window | null) {
  stopPopupWatcher();
  if (popup) {
    popupPollTimer = setInterval(() => {
      try {
        if (popup.closed && popupPollTimer) {
          clearInterval(popupPollTimer);
          popupPollTimer = null;
          if (authStatus.value === 'authorizing') {
            // Some browsers detach the opener during Google's redirect. Keep
            // listening until the state expires or the user starts another flow.
            authStatus.value = 'idle';
            MessagePlugin.info('授权窗口已关闭');
          }
        }
      } catch {}
    }, 1000);
  }
  popupTimeoutTimer = setTimeout(() => {
    stopPopupWatcher();
    if (authStatus.value === 'authorizing' || currentNonce.value) {
      cancelOAuth();
      MessagePlugin.warning('授权等待超时，请重试');
    }
  }, 15 * 60_000);
}

function cancelOAuth() {
  oauthGeneration++;
  currentNonce.value = '';
  authorizedRedirect = '';
  gdrive.value.authUrl = '';
  gdrive.value.code = '';
  authStatus.value = 'idle';
  gdriveSaving.value = false;
  cleanupOAuthListeners();
}

function cleanupOAuthListeners() {
  stopPopupWatcher();
  window.removeEventListener('message', onMessageReceived);
  window.removeEventListener('storage', onStorageEvent);
  if (bcChannel) {
    bcChannel.close();
    bcChannel = null;
  }
}

function onMessageReceived(event: MessageEvent) {
  if (event.origin !== window.location.origin) return;
  if (event.data?.type === 'TGTC_GDRIVE_OAUTH_RESULT') {
    handleOAuthCallbackResult(event.data);
  }
}

function onStorageEvent(event: StorageEvent) {
  if (event.key !== 'tgtc_gdrive_oauth_event' || !event.newValue) return;
  try {
    const data = JSON.parse(event.newValue);
    if (data?.type === 'TGTC_GDRIVE_OAUTH_RESULT') {
      handleOAuthCallbackResult(data);
    }
  } catch {}
}

function handleOAuthCallbackResult(data: { status: string; code?: string; state?: string; error?: string }) {
  if (authStatus.value === 'exchanging' || authStatus.value === 'success') return;
  if (!currentNonce.value || currentNonce.value !== data.state) return;
  stopPopupWatcher();

  if (data.status === 'error') {
    cancelOAuth();
    MessagePlugin.error('Google 授权失败: ' + (data.error || '用户取消授权'));
    return;
  }

  if (data.status === 'success' && data.code) {
    const cleanCode = extractOAuthCode(data.code);
    gdrive.value.code = cleanCode;
    void completeAuth(cleanCode);
  }
}

async function prepareAuthUrl(openPopup: boolean) {
  cancelOAuth();
  const generation = oauthGeneration;
  gdrive.value.redirectUri = gdrive.value.redirectUri.trim() || getDefaultRedirectUri();
  gdrive.value.authUrl = '';
  gdrive.value.code = '';
  const redirectUri = gdrive.value.redirectUri;
  authStatus.value = openPopup ? 'authorizing' : 'idle';
  authStatusMessage.value = '正在拉取 Google 授权链接...';
  gdriveSaving.value = true;

  try {
    const result = await fetchGDriveAuthUrl(redirectUri, gdrive.value.accountId ?? undefined);
    if (generation !== oauthGeneration) return;
    if (!result.state) throw new Error('请更新后端后重新生成授权链接');
    currentNonce.value = result.state;
    authorizedRedirect = redirectUri;
    gdrive.value.authUrl = result.url;
    setupOAuthListeners();
    if (!openPopup) {
      startPopupWatcher(null);
      return;
    }

    // 呼出居中授权弹窗
    const width = 600;
    const height = 700;
    const left = Math.max(0, Math.round(window.screenX + (window.outerWidth - width) / 2));
    const top = Math.max(0, Math.round(window.screenY + (window.outerHeight - height) / 2));
    const popup = window.open(
      result.url,
      'tgtc_gdrive_oauth',
      `width=${width},height=${height},left=${left},top=${top},status=no,resizable=yes,scrollbars=yes`,
    );
    popupRef.value = popup;
    startPopupWatcher(popup);
    if (!popup || popup.closed || typeof popup.closed === 'undefined') {
      MessagePlugin.warning('浏览器拦截了弹窗，请在下方点击手动打开授权页');
    }
    authStatusMessage.value = '已打开授权窗口，请在弹窗中选择 Google 账号并确认授权...';
  } catch (error) {
    if (generation === oauthGeneration) {
      cancelOAuth();
      MessagePlugin.error(getErrorMessage(error));
    }
  } finally {
    if (generation === oauthGeneration) gdriveSaving.value = false;
  }
}

function startOAuth() {
  return prepareAuthUrl(true);
}

function buildManualAuthUrl() {
  return prepareAuthUrl(false);
}

function openAuthUrl() {
  if (!currentNonce.value || !gdrive.value.authUrl || authStatus.value === 'exchanging') return;
  const popup = window.open(gdrive.value.authUrl, 'tgtc_gdrive_oauth');
  popupRef.value = popup;
  startPopupWatcher(popup);
}

function onManualCodeChange(value: string) {
  if (!/^https?:\/\//i.test(value.trim())) return;
  try {
    const url = new URL(value.trim());
    if (!currentNonce.value || url.searchParams.get('state') !== currentNonce.value) {
      throw new Error('回调地址与当前授权不匹配，请重新发起授权');
    }
    gdrive.value.code = url.searchParams.get('code') || '';
  } catch {
    gdrive.value.code = '';
    MessagePlugin.error('回调地址与当前授权不匹配，请重新发起授权');
  }
}

async function completeAuth(codeOverride?: string) {
  if (!currentNonce.value || authStatus.value === 'exchanging') return;
  if (!codeOverride) onManualCodeChange(gdrive.value.code);
  const codeToSubmit = (codeOverride || gdrive.value.code).trim();
  if (!codeToSubmit) return;
  const generation = oauthGeneration;
  authStatus.value = 'exchanging';
  authStatusMessage.value = '正在兑换授权码...';
  stopPopupWatcher();
  gdriveSaving.value = true;
  try {
    const result = await completeGDriveAuth({
      code: codeToSubmit, state: currentNonce.value,
      redirectUri: authorizedRedirect,
      name: gdrive.value.name || undefined,
      accountId: gdrive.value.accountId ?? undefined,
    });
    if (generation !== oauthGeneration) return;
    authStatus.value = 'success';
    MessagePlugin.success(result.message);
    if (popupRef.value && !popupRef.value.closed) {
      try {
        popupRef.value.close();
      } catch {}
    }
    cancelOAuth();
    gdriveVisible.value = false;
    await loadOverview();
  } catch (error) {
    if (generation === oauthGeneration) {
      cancelOAuth();
      MessagePlugin.error(getErrorMessage(error));
    }
  } finally {
    if (generation === oauthGeneration) gdriveSaving.value = false;
  }
}

onBeforeUnmount(cancelOAuth);

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
.default-backend-picker,
.chunk-size-picker {
  display: flex;
  gap: 8px;
  align-items: center;
}
.status-switch-control {
  display: flex;
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
  flex-wrap: wrap;
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
.wizard-card {
  border: 1px solid var(--td-border-level-1-color, #e7e7e7);
  border-radius: 8px;
  background: var(--td-bg-color-container, #ffffff);
  overflow: hidden;
  transition: all 0.2s ease;
}
.wizard-card.is-collapsed {
  background: var(--td-bg-color-secondarycontainer, #f9f9f9);
}
.wizard-card-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 12px 16px;
  background: var(--td-bg-color-secondarycontainer, #fafafa);
  border-bottom: 1px solid var(--td-border-level-1-color, #f0f0f0);
}
.wizard-card.is-collapsed .wizard-card-header {
  border-bottom: none;
}
.wizard-card-title {
  display: flex;
  align-items: center;
  gap: 8px;
}
.step-num {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 22px;
  height: 22px;
  border-radius: 50%;
  background: var(--td-brand-color, #0052d9);
  color: #fff;
  font-size: 12px;
  font-weight: 600;
}
.step-title {
  font-size: 14px;
  font-weight: 600;
  color: var(--td-text-color-primary, #333);
}
.wizard-card-body {
  padding: 16px;
}
.redirect-uri-box {
  background: var(--td-bg-color-page, #f3f5f8);
  padding: 12px;
  border-radius: 6px;
  margin-bottom: 14px;
}
.redirect-uri-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 6px;
}
.redirect-uri-label {
  font-size: 12px;
  font-weight: 500;
  color: var(--td-text-color-secondary, #666);
}
.name-row {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-bottom: 16px;
}
.form-label {
  font-size: 13px;
  font-weight: 500;
  color: var(--td-text-color-primary, #333);
  white-space: nowrap;
}
.existing-name {
  font-size: 14px;
  font-weight: 600;
  color: var(--td-brand-color, #0052d9);
}
.auth-action-area {
  margin-bottom: 16px;
}
.auth-status-box {
  display: flex;
  align-items: center;
  gap: 16px;
  padding: 16px;
  background: var(--td-brand-color-light, #f2f5fd);
  border-radius: 8px;
  border: 1px solid var(--td-brand-color-focus, #d4e3fc);
}
.auth-spinner {
  width: 32px;
  height: 32px;
  border: 3px solid var(--td-brand-color-light, #d4e3fc);
  border-top-color: var(--td-brand-color, #0052d9);
  border-radius: 50%;
  animation: spin 0.8s linear infinite;
  flex-shrink: 0;
}
@keyframes spin {
  to {
    transform: rotate(360deg);
  }
}
.auth-status-info {
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.auth-status-main {
  font-size: 14px;
  font-weight: 600;
  color: var(--td-brand-color, #0052d9);
}
.auth-status-sub {
  font-size: 12px;
  color: var(--td-text-color-secondary, #666);
}
.link-btn {
  color: var(--td-brand-color, #0052d9);
  text-decoration: underline;
  cursor: pointer;
}
.auth-btn-area {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.disabled-tip {
  font-size: 12px;
  color: var(--td-error-color, #e34d59);
  text-align: center;
}
.fallback-accordion {
  margin-top: 12px;
  border-top: 1px dashed var(--td-border-level-1-color, #e7e7e7);
  padding-top: 12px;
}
.fallback-toggle {
  font-size: 12px;
  color: var(--td-text-color-secondary, #888);
  cursor: pointer;
  user-select: none;
  transition: color 0.2s;
}
.fallback-toggle:hover {
  color: var(--td-brand-color, #0052d9);
}
.fallback-body {
  margin-top: 12px;
  padding: 12px;
  background: var(--td-bg-color-page, #f8f9fb);
  border-radius: 6px;
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
.status-switch-btns {
  display: flex;
  gap: 8px;
  align-items: center;
}
.name-cell {
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.account-name {
  font-weight: 500;
}
.account-email {
  font-size: 11px;
  color: var(--td-brand-color, #0052d9);
  background: var(--td-brand-color-light, #f2f5fd);
  padding: 1px 6px;
  border-radius: 4px;
  width: fit-content;
}
.oauth-client-dialog {
  display: flex;
  flex-direction: column;
  gap: 14px;
}
.dialog-footer-actions {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 16px;
  padding-top: 12px;
  border-top: 1px solid var(--td-border-level-1-color, #f0f0f0);
}
</style>
