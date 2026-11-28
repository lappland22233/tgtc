<template>
  <section id="tg-accounts" class="card" aria-label="账号管理">
    <div class="section-header">
      <h3>账号</h3>
      <div class="section-actions">
        <t-button variant="outline" size="small" @click="openCreateBot">添加 Bot 账号</t-button>
        <t-button variant="outline" size="small" @click="openCreateUser">添加用户账号</t-button>
      </div>
    </div>

    <t-tabs v-model="accountTab" @change="onAccountTabChange">
      <t-tab-panel value="bot" label="Bot 账号" />
      <t-tab-panel value="user" label="用户账号" />
    </t-tabs>

    <!-- 环境变量账号只读区（独立于数据库账号列表，不参与分页/筛选） -->
    <div v-if="accountTab === 'bot'" class="env-accounts" aria-label="环境变量账号">
      <div class="env-accounts-head">
        <h4 class="env-accounts-title">环境变量账号</h4>
        <span class="section-hint">
          来自 .env（TELEGRAM_BOT_TOKEN / TELEGRAM_ACCOUNT_POOL），后台只读：密钥轮换请改 .env，不提供编辑/删除/轮换。
        </span>
      </div>

      <t-alert
        v-if="poolNotice"
        :theme="poolNotice.theme"
        :title="poolNotice.title"
        :message="poolNotice.message"
      />

      <div v-if="envAccounts.length === 0" class="empty-hint">未检测到环境变量账号</div>

      <ul v-else class="env-account-list">
        <li v-for="account in envAccounts" :key="account.id" class="env-account-row">
          <div class="env-account-main">
            <div class="env-account-head">
              <t-tag theme="primary" variant="light" size="small">环境变量</t-tag>
              <t-tag v-if="account.primary" theme="warning" variant="light" size="small">主 Bot</t-tag>
              <span class="cell-strong env-account-id">{{ account.id }}</span>
              <span class="cell-mono">{{ account.tokenPreview }}</span>
              <t-tag :theme="account.enabled ? 'success' : 'default'" variant="light" size="small">
                {{ account.enabled ? '已启用' : '已停用' }}
              </t-tag>
            </div>

            <dl class="env-account-meta">
              <div class="env-meta-item">
                <dt>存储 Chat</dt>
                <dd>
                  <span v-if="account.chatId" class="cell-mono">{{ account.chatId }}</span>
                  <span v-else class="cell-muted">未配置存储 Chat</span>
                </dd>
              </div>
              <div class="env-meta-item">
                <dt>权重</dt>
                <dd>{{ account.weight }}</dd>
              </div>
              <div class="env-meta-item">
                <dt>在飞</dt>
                <dd>{{ account.runtime.inflight }} / {{ account.runtime.maxInflight }}</dd>
              </div>
              <div class="env-meta-item">
                <dt>带宽</dt>
                <dd>{{ formatBandwidth(account.runtime.bandwidthMbps) }}</dd>
              </div>
              <div class="env-meta-item">
                <dt>健康</dt>
                <dd>
                  <t-tag :theme="envHealthTheme(account.runtime)" variant="light" size="small">
                    {{ envHealthText(account.runtime) }}
                  </t-tag>
                </dd>
              </div>
              <div class="env-meta-item">
                <dt>成功率</dt>
                <dd>{{ formatSuccessRate(account.runtime.successRate) }}</dd>
              </div>
              <div class="env-meta-item">
                <dt>冷却剩余</dt>
                <dd>{{ formatCooldown(account.runtime.cooldownRemainingMs) }}</dd>
              </div>
              <div class="env-meta-item">
                <dt>最近错误</dt>
                <dd>{{ errorKindText(account.runtime.lastErrorKind) }}</dd>
              </div>
            </dl>

            <p v-if="!account.runtime.storageConfigured" class="env-account-warn">
              未配置存储 Chat：仅参与下载回源，不会被选为文件存储或镜像目标。
            </p>
          </div>

          <div class="env-account-actions">
            <t-button
              variant="outline"
              size="small"
              :loading="envProbingId === account.id"
              @click="runEnvProbe(account)"
            >
              重新探测
            </t-button>
          </div>
        </li>
      </ul>
    </div>

    <div class="table-filters">
      <t-select v-model="accountStatus" class="filter-select" placeholder="状态" @change="onAccountFilterChange">
        <t-option value="" label="全部（不含已撤销）" />
        <t-option value="active" :label="statusText('active')" />
        <t-option value="degraded" :label="statusText('degraded')" />
        <t-option value="disabled" :label="statusText('disabled')" />
        <t-option value="revoked" :label="statusText('revoked')" />
        <t-option value="pending_auth" :label="statusText('pending_auth')" />
      </t-select>
      <t-input
        v-model="accountKeyword"
        class="filter-input"
        placeholder="搜索名称或外部标识…"
        clearable
        autocomplete="off"
        name="telegram-account-keyword"
        @enter="onAccountFilterChange"
        @clear="onAccountFilterChange"
      />
      <t-button variant="outline" :loading="accountsLoading" @click="onAccountFilterChange">查询</t-button>
    </div>

    <div v-if="!isMobile" class="table-scroll">
      <t-table
        :data="accounts"
        :columns="accountColumns"
        :loading="accountsLoading"
        row-key="id"
        table-layout="fixed"
        :pagination="false"
        size="small"
      >
        <template #name="{ row }">
          <div class="cell-stack">
            <span class="cell-strong">{{ row.name }}</span>
            <span class="cell-mono">Token：{{ row.externalId || '—' }}</span>
            <t-tag v-if="row.source === 'both'" theme="primary" variant="light" size="small">
              双来源（环境变量优先）
            </t-tag>
            <span v-if="row.source === 'both'" class="cell-note">同一 Bot 已被环境变量注册，密钥以 .env 为准</span>
            <span v-if="row.runtime" class="cell-note">{{ runtimeSummary(row.runtime) }}</span>
          </div>
        </template>
        <template #status="{ row }">
          <t-tag :theme="statusTheme(row.status)" variant="light">{{ statusText(row.status) }}</t-tag>
        </template>
        <template #capabilities="{ row }">{{ capabilityText(row) }}</template>
        <template #enabled="{ row }">
          <t-switch
            :value="row.enabled"
            :disabled="row.status === 'revoked' || row.status === 'pending_auth'"
            @change="(v: boolean) => toggleAccountEnabled(row, Boolean(v))"
          />
        </template>
        <template #weight="{ row }">{{ row.weight }} / {{ row.maxInflight }}</template>
        <template #lastSuccessAt="{ row }">{{ formatTime(row.lastSuccessAt) }}</template>
        <template #lastError="{ row }">
          <span v-if="row.lastFailureSummary" class="cell-error">{{ row.lastFailureSummary }}</span>
          <span v-else class="cell-muted">—</span>
        </template>
        <template #operations="{ row }">
          <div class="row-actions">
            <t-button variant="text" size="small" @click="runAccountTest(row)">测试</t-button>
            <t-button
              v-if="row.type === 'user'"
              variant="text"
              size="small"
              @click="openAuthorize(row)"
            >
              授权
            </t-button>
            <t-button variant="text" size="small" @click="openEdit(row)">编辑</t-button>
            <t-button variant="text" size="small" @click="openRotate(row)">轮换</t-button>
            <t-button
              v-if="row.status !== 'revoked'"
              variant="text"
              theme="danger"
              size="small"
              @click="confirmDelete(row)"
            >
              删除
            </t-button>
          </div>
        </template>
      </t-table>
    </div>

    <div v-else class="mobile-card-list">
      <div v-for="row in accounts" :key="row.id" class="mobile-account-card">
        <div class="mobile-card-head">
          <span class="cell-strong">{{ row.name }}</span>
          <t-tag :theme="statusTheme(row.status)" variant="light">{{ statusText(row.status) }}</t-tag>
        </div>
        <div class="mobile-card-meta">Token：{{ row.externalId || '—' }}</div>
        <div v-if="row.source === 'both'" class="mobile-card-meta">
          双来源（环境变量优先）：密钥以 .env 为准
        </div>
        <div v-if="row.runtime" class="mobile-card-meta">运行态：{{ runtimeSummary(row.runtime) }}</div>
        <div class="mobile-card-meta">能力：{{ capabilityText(row) }}</div>
        <div class="mobile-card-meta">权重 / 并发：{{ row.weight }} / {{ row.maxInflight }}</div>
        <div class="mobile-card-meta">最近成功：{{ formatTime(row.lastSuccessAt) }}</div>
        <div v-if="row.lastFailureSummary" class="mobile-card-meta cell-error">最近错误：{{ row.lastFailureSummary }}</div>
        <div class="mobile-card-actions">
          <t-button variant="text" size="small" @click="runAccountTest(row)">测试</t-button>
          <t-button v-if="row.type === 'user'" variant="text" size="small" @click="openAuthorize(row)">授权</t-button>
          <t-button variant="text" size="small" @click="openEdit(row)">编辑</t-button>
          <t-button variant="text" size="small" @click="openRotate(row)">轮换</t-button>
          <t-button
            v-if="row.status !== 'revoked'"
            variant="text"
            theme="danger"
            size="small"
            @click="confirmDelete(row)"
          >
            删除
          </t-button>
        </div>
      </div>
      <div v-if="!accountsLoading && accounts.length === 0" class="empty-hint">暂无账号</div>
    </div>

    <div class="pagination-row">
      <t-pagination
        :current="accountPagination.current"
        :total="accountPagination.total"
        :page-size="accountPagination.pageSize"
        :page-size-options="[10, 20, 50]"
        size="small"
        @change="onAccountPageChange"
      />
    </div>

    <!-- 新增 / 编辑账号弹窗 -->
    <t-dialog
      v-model:visible="accountDialogVisible"
      :header="accountDialogHeader"
      :footer="false"
    >
      <div class="dialog-form">
        <label class="field">
          <span class="field-label">名称</span>
          <t-input v-model="accountForm.name" placeholder="便于识别的名称" autocomplete="off" name="account-name" />
        </label>

        <template v-if="accountFormMode === 'create-bot'">
          <label class="field">
            <span class="field-label">Bot Token</span>
            <t-input v-model="accountForm.token" type="password" placeholder="<botId>:<secret>" autocomplete="off" name="account-token" />
          </label>
          <label class="field">
            <span class="field-label">主存储 Chat ID</span>
            <t-input v-model="accountForm.primaryChatId" placeholder="可空" autocomplete="off" name="account-primary-chat" />
          </label>
          <div class="field-row">
            <label class="field">
              <span class="field-label">权重</span>
              <t-input-number v-model="accountForm.weight" :min="1" :max="100" />
            </label>
            <label class="field">
              <span class="field-label">并发上限</span>
              <t-input-number v-model="accountForm.maxInflight" :min="1" :max="64" />
            </label>
          </div>
        </template>

        <template v-else-if="accountFormMode === 'create-user'">
          <label class="field">
            <span class="field-label">API ID</span>
            <t-input
              v-model="accountForm.apiId"
              placeholder="例如 1234567"
              inputmode="numeric"
              pattern="[0-9]+"
              autocomplete="off"
              name="account-api-id"
            />
          </label>
          <label class="field">
            <span class="field-label">API Hash</span>
            <t-input v-model="accountForm.apiHash" type="password" autocomplete="off" name="account-api-hash" />
          </label>
          <label class="field">
            <span class="field-label">手机号</span>
            <t-input v-model="accountForm.phoneNumber" placeholder="+8613800000000" autocomplete="off" name="account-phone" />
          </label>
        </template>

        <template v-else>
          <div class="field-row">
            <label class="field">
              <span class="field-label">权重</span>
              <t-input-number v-model="accountForm.weight" :min="1" :max="100" />
            </label>
            <label class="field">
              <span class="field-label">并发上限</span>
              <t-input-number v-model="accountForm.maxInflight" :min="1" :max="64" />
            </label>
          </div>
          <label class="field">
            <span class="field-label">主存储 Chat ID</span>
            <t-input v-model="accountForm.primaryChatId" placeholder="可空" autocomplete="off" name="account-primary-chat" />
          </label>
        </template>

        <label class="field">
          <span class="field-label">备注</span>
          <t-textarea v-model="accountForm.note" :maxlength="255" placeholder="可空" />
        </label>
      </div>
      <div class="dialog-footer">
        <t-button variant="outline" @click="closeAccountDialog">取消</t-button>
        <t-button theme="primary" :loading="accountDialogSubmitting" @click="submitAccountForm">
          {{ accountDialogSubmitting ? '提交中…' : '提交' }}
        </t-button>
      </div>
    </t-dialog>

    <!-- 用户账号授权弹窗（发送验证码 → 提交验证码） -->
    <t-dialog
      v-model:visible="authDialogVisible"
      header="用户账号授权"
      :footer="false"
    >
      <div class="dialog-form">
        <template v-if="authStep === 'code'">
          <p class="dialog-hint">验证码将发送到该账号的 Telegram 客户端，请确保手机号带国家码。</p>
          <label class="field">
            <span class="field-label">手机号</span>
            <t-input v-model="authPhoneNumber" placeholder="+8613800000000" autocomplete="off" name="auth-phone" />
          </label>
        </template>
        <template v-else>
          <p class="dialog-hint">
            验证码已发送<template v-if="authPhoneMasked">（{{ authPhoneMasked }}）</template>，请在 10 分钟内提交。
          </p>
          <label class="field">
            <span class="field-label">验证码</span>
            <t-input v-model="authCode" placeholder="Telegram 收到的验证码" autocomplete="off" name="auth-code" />
          </label>
          <label class="field">
            <span class="field-label">2FA 密码（可选）</span>
            <t-input v-model="authPassword" type="password" placeholder="如账号开启了两步验证" autocomplete="off" name="auth-password" />
          </label>
        </template>
      </div>
      <div class="dialog-footer">
        <t-button variant="outline" @click="closeAuthDialog">取消</t-button>
        <t-button theme="primary" :loading="authSending || authVerifying" @click="advanceAuth">
          {{ authStep === 'code' ? (authSending ? '发送中…' : '发送验证码') : (authVerifying ? '提交中…' : '提交授权') }}
        </t-button>
      </div>
    </t-dialog>

    <!-- 轮换凭据弹窗 -->
    <t-dialog
      v-model:visible="rotateDialogVisible"
      :header="rotateDialogHeader"
      :confirm-btn="{ content: rotateSubmitting ? '提交中…' : '提交', loading: rotateSubmitting }"
      @confirm="submitRotate"
    >
      <div class="dialog-form">
        <template v-if="rotateType === 'bot'">
          <label class="field">
            <span class="field-label">新 Bot Token</span>
            <t-input v-model="rotateForm.token" type="password" placeholder="<botId>:<secret>" autocomplete="off" name="rotate-token" />
          </label>
          <label class="field">
            <span class="field-label">主存储 Chat ID</span>
            <t-input v-model="rotateForm.primaryChatId" placeholder="留空则保持原值" autocomplete="off" name="rotate-primary-chat" />
          </label>
        </template>
        <template v-else>
          <p class="dialog-hint">更新凭据后需要重新完成交互式授权。</p>
          <label class="field">
            <span class="field-label">API ID</span>
            <t-input
              v-model="rotateForm.apiId"
              placeholder="例如 1234567"
              inputmode="numeric"
              pattern="[0-9]+"
              autocomplete="off"
              name="rotate-api-id"
            />
          </label>
          <label class="field">
            <span class="field-label">API Hash</span>
            <t-input v-model="rotateForm.apiHash" type="password" autocomplete="off" name="rotate-api-hash" />
          </label>
          <label class="field">
            <span class="field-label">手机号</span>
            <t-input v-model="rotateForm.phoneNumber" autocomplete="off" name="rotate-phone" />
          </label>
        </template>
      </div>
      <div class="dialog-footer">
        <t-button variant="outline" @click="rotateDialogVisible = false">取消</t-button>
        <t-button theme="primary" :loading="rotateSubmitting" @click="submitRotate">
          {{ rotateSubmitting ? '提交中…' : '提交' }}
        </t-button>
      </div>
    </t-dialog>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue';
import { DialogPlugin } from 'tdesign-vue-next/es/dialog';
import MessagePlugin from '@/utils/message';
import { getErrorMessage } from '@/utils/error';
import { useMobile } from '@/composables/useMobile';
import {
  createBotAccount,
  createUserAccount,
  deleteAccount,
  fetchAccounts,
  probeEnvAccount,
  rotateAccount,
  startUserAuth,
  testAccount,
  updateAccount,
  verifyUserAuth,
  type AccountPoolOverview,
  type TelegramAccountStatus,
  type TelegramAccountType,
  type TelegramAccountView,
  type TelegramEnvAccountView,
  type UpdateTelegramAccountInput,
} from '@/api/telegram-accounts';
import {
  envHealthText,
  envHealthTheme,
  errorKindText,
  formatBandwidth,
  formatCooldown,
  formatSuccessRate,
  formatTime,
  runtimeSummary,
} from '@/utils/telegram-format';

const props = defineProps<{
  overview: AccountPoolOverview | null;
}>();

const emit = defineEmits<{
  'refresh-overview': [];
}>();

const isMobile = useMobile();

const accountTab = ref<TelegramAccountType>('bot');
const accounts = ref<TelegramAccountView[]>([]);
const accountsLoading = ref(false);
const accountKeyword = ref('');
/** 账号状态筛选：默认空字符串 = 「全部（不含已撤销）」（后端默认即排除 revoked） */
const accountStatus = ref<TelegramAccountStatus | ''>('');
const accountPagination = reactive({ current: 1, pageSize: 20, total: 0 });

const accountColumns = [
  { colKey: 'name', title: '名称', width: 200 },
  { colKey: 'status', title: '状态', width: 100 },
  { colKey: 'capabilities', title: '能力', width: 180 },
  { colKey: 'enabled', title: '启用', width: 80 },
  { colKey: 'weight', title: '权重 / 并发', width: 110 },
  { colKey: 'lastSuccessAt', title: '最近成功', width: 160 },
  { colKey: 'lastError', title: '最近错误', width: 220 },
  { colKey: 'operations', title: '操作', width: 240 },
];

const STATUS_TEXT: Record<TelegramAccountStatus, string> = {
  active: '正常',
  degraded: '降级',
  disabled: '已停用',
  revoked: '已撤销',
  pending_auth: '待授权',
  draining: '排空中',
};

const STATUS_THEME: Record<TelegramAccountStatus, 'default' | 'success' | 'warning' | 'danger'> = {
  active: 'success',
  degraded: 'warning',
  disabled: 'default',
  revoked: 'danger',
  pending_auth: 'warning',
  draining: 'default',
};

function statusText(status: TelegramAccountStatus): string {
  return STATUS_TEXT[status] ?? status;
}

function statusTheme(status: TelegramAccountStatus): 'default' | 'success' | 'warning' | 'danger' {
  return STATUS_THEME[status] ?? 'default';
}

function capabilityText(account: TelegramAccountView): string {
  const caps = account.capabilities;
  if (!caps) return '未测试';
  const parts: string[] = [];
  if (caps.canUpload) parts.push('可上传');
  if (caps.canReadSource) parts.push('可读源');
  if (caps.canWriteMirror) parts.push('可写备份');
  if (caps.supportsPolling) parts.push('可轮询');
  return parts.length > 0 ? parts.join(' / ') : '无可用能力';
}

async function loadAccounts() {
  accountsLoading.value = true;
  try {
    const { items, total } = await fetchAccounts({
      type: accountTab.value,
      status: accountStatus.value || undefined,
      keyword: accountKeyword.value.trim() || undefined,
      page: accountPagination.current,
      pageSize: accountPagination.pageSize,
    });
    accounts.value = items;
    accountPagination.total = total;
  } catch {
    MessagePlugin.error('账号列表加载失败，已保留上次数据');
  } finally {
    accountsLoading.value = false;
  }
}

function onAccountTabChange() {
  accountPagination.current = 1;
  loadAccounts();
}

function onAccountFilterChange() {
  accountPagination.current = 1;
  loadAccounts();
}

function onAccountPageChange(pageInfo: { current: number; pageSize: number }) {
  accountPagination.current = pageInfo.current;
  accountPagination.pageSize = pageInfo.pageSize;
  loadAccounts();
}

type AccountFormMode = 'create-bot' | 'create-user' | 'edit';

const accountDialogVisible = ref(false);
const accountDialogSubmitting = ref(false);
const accountFormMode = ref<AccountFormMode>('create-bot');
const editingAccountId = ref<string | null>(null);
const accountForm = reactive({
  name: '',
  token: '',
  primaryChatId: '',
  weight: 1,
  maxInflight: 16,
  apiId: '',
  apiHash: '',
  phoneNumber: '',
  note: '',
});

const accountDialogHeader = computed(() => {
  if (accountFormMode.value === 'create-bot') return '添加 Bot 账号';
  if (accountFormMode.value === 'create-user') return '添加用户账号';
  return '编辑账号';
});

function resetAccountForm() {
  accountForm.name = '';
  accountForm.token = '';
  accountForm.primaryChatId = '';
  accountForm.weight = 1;
  accountForm.maxInflight = 16;
  accountForm.apiId = '';
  accountForm.apiHash = '';
  accountForm.phoneNumber = '';
  accountForm.note = '';
}

function openCreateBot() {
  resetAccountForm();
  accountFormMode.value = 'create-bot';
  editingAccountId.value = null;
  accountDialogVisible.value = true;
}

function openCreateUser() {
  resetAccountForm();
  accountFormMode.value = 'create-user';
  editingAccountId.value = null;
  accountDialogVisible.value = true;
}

function openEdit(account: TelegramAccountView) {
  resetAccountForm();
  accountFormMode.value = 'edit';
  editingAccountId.value = account.id;
  accountForm.name = account.name;
  accountForm.weight = account.weight;
  accountForm.maxInflight = account.maxInflight;
  accountForm.primaryChatId = account.primaryChatId ?? '';
  accountForm.note = account.note ?? '';
  accountDialogVisible.value = true;
}

function closeAccountDialog() {
  accountDialogVisible.value = false;
  accountForm.token = '';
  accountForm.apiHash = '';
}

async function submitAccountForm() {
  if (accountDialogSubmitting.value) return;
  accountDialogSubmitting.value = true;
  try {
    let postCreateAuthAccount: TelegramAccountView | null = null;
    if (accountFormMode.value === 'create-bot') {
      if (!accountForm.name.trim() || !accountForm.token.trim()) {
        MessagePlugin.warning('请填写名称与 Bot Token');
        return;
      }
      await createBotAccount({
        name: accountForm.name.trim(),
        token: accountForm.token.trim(),
        primaryChatId: accountForm.primaryChatId.trim() || undefined,
        weight: accountForm.weight,
        maxInflight: accountForm.maxInflight,
        note: accountForm.note.trim() || undefined,
      });
      MessagePlugin.success('Bot 账号已添加');
    } else if (accountFormMode.value === 'create-user') {
      if (!accountForm.name.trim() || !accountForm.apiHash.trim()) {
        MessagePlugin.warning('请填写名称与 API 凭据');
        return;
      }
      const apiId = Number(accountForm.apiId.trim());
      if (!Number.isInteger(apiId) || apiId <= 0) {
        MessagePlugin.warning('API ID 必须是正整数');
        return;
      }
      const created = await createUserAccount({
        name: accountForm.name.trim(),
        apiId,
        apiHash: accountForm.apiHash.trim(),
        phoneNumber: accountForm.phoneNumber.trim() || undefined,
        note: accountForm.note.trim() || undefined,
      });
      MessagePlugin.success('用户账号已创建，请完成交互式授权');
      postCreateAuthAccount = created.account;
    } else if (editingAccountId.value) {
      const payload: UpdateTelegramAccountInput = {
        name: accountForm.name.trim() || undefined,
        weight: accountForm.weight,
        maxInflight: accountForm.maxInflight,
        primaryChatId: accountForm.primaryChatId.trim(),
        note: accountForm.note.trim(),
      };
      await updateAccount(editingAccountId.value, payload);
      MessagePlugin.success('账号已更新');
    }
    const prefillPhone = accountForm.phoneNumber.trim();
    closeAccountDialog();
    emit('refresh-overview');
    await loadAccounts();
    if (postCreateAuthAccount) {
      openAuthorize(postCreateAuthAccount);
      if (prefillPhone) authPhoneNumber.value = prefillPhone;
    }
  } catch (error) {
    MessagePlugin.error(getErrorMessage(error));
  } finally {
    accountDialogSubmitting.value = false;
  }
}

async function toggleAccountEnabled(account: TelegramAccountView, enabled: boolean) {
  try {
    await updateAccount(account.id, { enabled });
    MessagePlugin.success(enabled ? '账号已启用' : '账号已停用');
    emit('refresh-overview');
    await loadAccounts();
  } catch (error) {
    MessagePlugin.error(getErrorMessage(error));
  }
}

async function runAccountTest(account: TelegramAccountView) {
  try {
    await testAccount(account.id);
    MessagePlugin.success('测试完成');
    emit('refresh-overview');
    await loadAccounts();
  } catch (error) {
    MessagePlugin.error(getErrorMessage(error));
    await loadAccounts();
  }
}

function confirmDelete(account: TelegramAccountView) {
  const dialog = DialogPlugin.confirm({
    header: '删除账号',
    body: `确定删除账号「${account.name}」吗？删除后立即停止参与新任务并清空凭据，Telegram 远端备份不会被删除。`,
    theme: 'danger',
    onConfirm: async () => {
      dialog.destroy();
      try {
        await deleteAccount(account.id);
        MessagePlugin.success('账号已撤销');
        if (accounts.value.length === 1 && accountPagination.current > 1) {
          accountPagination.current -= 1;
        }
        emit('refresh-overview');
        await loadAccounts();
      } catch (error) {
        MessagePlugin.error(getErrorMessage(error));
      }
    },
    onClose: () => dialog.destroy(),
  });
}

const envAccounts = computed<TelegramEnvAccountView[]>(() => props.overview?.envAccounts ?? []);
const envProbingId = ref<string | null>(null);

const poolNotice = computed<{ theme: 'info' | 'warning' | 'success'; title: string; message: string } | null>(() => {
  const data = props.overview;
  if (!data) return null;
  const pool = data.pool;
  const primaryAccountId = pool?.primaryAccountId ?? null;

  if (!primaryAccountId) {
    return {
      theme: 'info',
      title: '未配置环境变量主 Bot',
      message: '未设置 TELEGRAM_BOT_TOKEN：账号池中没有环境变量主 Bot，后台账号全部来自数据库。',
    };
  }

  const primaryPrecheck = data.precheck.find((item) => item.id === 'primary_bot');
  const primaryEnv = envAccounts.value.find((account) => account.primary);
  const primaryUnhealthy = Boolean(
    primaryEnv && (primaryEnv.runtime.coolingDown || primaryEnv.runtime.consecutiveFailures > 0),
  );
  if ((primaryPrecheck && !primaryPrecheck.ok) || primaryUnhealthy) {
    return {
      theme: 'warning',
      title: '环境变量主 Bot 当前不可用',
      message: primaryPrecheck && !primaryPrecheck.ok
        ? primaryPrecheck.hint
        : `主 Bot ${primaryAccountId} 探测失败或处于冷却（连续失败 ${primaryEnv?.runtime.consecutiveFailures ?? 0} 次），调度器已暂时摘除该账号。`,
    };
  }

  if (data.feature.accountPoolForceDisabled) {
    return {
      theme: 'warning',
      title: '账号池已被环境变量强制关闭',
      message: 'FORCE_DISABLED 生效：面板无法开启账号池，请检查部署环境变量。',
    };
  }

  if (!pool?.enabled) {
    const reason = pool?.inactiveReason ?? '';
    if (reason.includes('未解析到任何账号')) {
      return {
        theme: 'warning',
        title: '账号池已开启但没有可调度账号',
        message: reason,
      };
    }
    return {
      theme: 'info',
      title: '账号池未生效',
      message: reason || '账号池当前未启用。',
    };
  }

  return {
    theme: 'success',
    title: '账号池已生效',
    message: `池内共 ${pool.accountCount} 个账号（其中环境变量 ${pool.envAccountCount} 个）。`,
  };
});

async function runEnvProbe(account: TelegramEnvAccountView) {
  if (envProbingId.value) return;
  envProbingId.value = account.id;
  try {
    const result = await probeEnvAccount(account.id);
    const conclusion = result.message || (result.probe.ok ? '环境变量账号探测通过' : '环境变量账号探测失败');
    if (result.probe.ok) {
      MessagePlugin.success(conclusion);
    } else {
      MessagePlugin.error(conclusion);
    }
  } catch (error) {
    MessagePlugin.error(getErrorMessage(error));
  } finally {
    envProbingId.value = null;
    emit('refresh-overview');
    await loadAccounts();
  }
}

const rotateDialogVisible = ref(false);
const rotateSubmitting = ref(false);
const rotateAccountId = ref<string | null>(null);
const rotateType = ref<TelegramAccountType>('bot');
const rotateForm = reactive({
  token: '',
  primaryChatId: '',
  apiId: '',
  apiHash: '',
  phoneNumber: '',
});

const rotateDialogHeader = computed(() => (rotateType.value === 'bot' ? '轮换 Bot Token' : '更新用户凭据'));

function openRotate(account: TelegramAccountView) {
  rotateAccountId.value = account.id;
  rotateType.value = account.type;
  rotateForm.token = '';
  rotateForm.primaryChatId = account.primaryChatId ?? '';
  rotateForm.apiId = '';
  rotateForm.apiHash = '';
  rotateForm.phoneNumber = '';
  rotateDialogVisible.value = true;
}

async function submitRotate() {
  if (!rotateAccountId.value || rotateSubmitting.value) return;
  rotateSubmitting.value = true;
  try {
    if (rotateType.value === 'bot') {
      if (!rotateForm.token.trim()) {
        MessagePlugin.warning('请输入新的 Bot Token');
        return;
      }
      await rotateAccount(rotateAccountId.value, {
        token: rotateForm.token.trim(),
        primaryChatId: rotateForm.primaryChatId.trim() || undefined,
      });
      MessagePlugin.success('Bot 凭据已轮换');
    } else {
      const apiId = Number(rotateForm.apiId.trim());
      if (!Number.isInteger(apiId) || apiId <= 0) {
        MessagePlugin.warning('API ID 必须是正整数');
        return;
      }
      await rotateAccount(rotateAccountId.value, {
        apiId,
        apiHash: rotateForm.apiHash.trim() || undefined,
        phoneNumber: rotateForm.phoneNumber.trim() || undefined,
      });
      MessagePlugin.success('用户账号凭据已更新，请重新完成授权');
    }
    rotateDialogVisible.value = false;
    rotateForm.token = '';
    rotateForm.apiHash = '';
    emit('refresh-overview');
    await loadAccounts();
  } catch (error) {
    MessagePlugin.error(getErrorMessage(error));
  } finally {
    rotateSubmitting.value = false;
  }
}

const authDialogVisible = ref(false);
const authAccountId = ref<string | null>(null);
const authStep = ref<'code' | 'verify'>('code');
const authPhoneNumber = ref('');
const authCode = ref('');
const authPassword = ref('');
const authPhoneMasked = ref<string | null>(null);
const authSending = ref(false);
const authVerifying = ref(false);

function openAuthorize(account: TelegramAccountView) {
  authAccountId.value = account.id;
  authStep.value = 'code';
  authPhoneNumber.value = '';
  authCode.value = '';
  authPassword.value = '';
  authPhoneMasked.value = null;
  authDialogVisible.value = true;
}

function closeAuthDialog() {
  authDialogVisible.value = false;
  authCode.value = '';
  authPassword.value = '';
}

async function advanceAuth() {
  if (!authAccountId.value) return;
  if (authStep.value === 'code') {
    authSending.value = true;
    try {
      const result = await startUserAuth(authAccountId.value, {
        phoneNumber: authPhoneNumber.value.trim() || undefined,
      });
      authPhoneMasked.value = result.phoneMasked;
      authStep.value = 'verify';
      MessagePlugin.success('验证码已发送');
    } catch (error) {
      MessagePlugin.error(getErrorMessage(error));
    } finally {
      authSending.value = false;
    }
    return;
  }

  if (!authCode.value.trim()) {
    MessagePlugin.warning('请输入验证码');
    return;
  }
  authVerifying.value = true;
  try {
    await verifyUserAuth(authAccountId.value, {
      code: authCode.value.trim(),
      password: authPassword.value || undefined,
    });
    MessagePlugin.success('授权成功');
    closeAuthDialog();
    emit('refresh-overview');
    await loadAccounts();
  } catch (error) {
    MessagePlugin.error(getErrorMessage(error));
  } finally {
    authVerifying.value = false;
  }
}

onMounted(() => {
  void loadAccounts();
});
</script>

<style scoped>
.filter-input,
.filter-select {
  width: 100%;
}

.cell-stack {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.cell-strong {
  font-weight: 600;
  color: var(--text-primary);
}

.cell-mono {
  font-family: var(--font-mono);
  font-size: 12px;
  color: var(--text-secondary);
}

.cell-muted {
  color: var(--text-tertiary);
}

.cell-error {
  color: var(--color-danger);
  font-size: 12px;
}

.cell-note {
  font-size: 12px;
  color: var(--text-tertiary);
}

.row-actions {
  display: flex;
  gap: var(--space-1);
  flex-wrap: wrap;
}

.mobile-account-card {
  background: var(--color-bg-elevated);
  border: 1px solid var(--border-default);
  border-radius: var(--radius-md);
  padding: var(--space-3);
}

.mobile-account-card + .mobile-account-card {
  margin-top: var(--space-3);
}

.pagination-row {
  justify-content: center;
}

.env-accounts {
  margin: var(--space-4) 0;
  padding: var(--space-4);
  background: var(--color-bg-elevated);
  border: 1px solid var(--border-default);
  border-radius: var(--radius-md);
}

.env-accounts-head {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
  margin-bottom: var(--space-3);
}

.env-accounts-title {
  margin: 0;
  font-family: var(--font-display);
  font-size: 15px;
  font-weight: 600;
  color: var(--text-primary);
}

.env-account-list {
  list-style: none;
  margin: var(--space-3) 0 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
}

.env-account-row {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: var(--space-3);
  flex-wrap: wrap;
  padding: var(--space-3);
  background: var(--color-bg-surface);
  border: 1px solid var(--border-default);
  border-radius: var(--radius-sm);
}

.env-account-main {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}

.env-account-head {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  flex-wrap: wrap;
}

.env-account-id {
  font-family: var(--font-mono);
  font-size: 13px;
}

.env-account-meta {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(min(100%, 120px), 1fr));
  gap: var(--space-2) var(--space-3);
  margin: 0;
}

.env-meta-item {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}

.env-meta-item dt {
  font-size: 11px;
  color: var(--text-tertiary);
  text-transform: uppercase;
  letter-spacing: 0.06em;
}

.env-meta-item dd {
  margin: 0;
  font-size: 13px;
  color: var(--text-primary);
  word-break: break-all;
}

.env-account-warn {
  margin: 0;
  font-size: 12px;
  color: var(--color-warning);
}

.env-account-actions {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  flex-shrink: 0;
}

.dialog-form {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
}

.field {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
  min-width: 0;
}

.field-row {
  display: flex;
  gap: var(--space-3);
  flex-wrap: wrap;
}

.field-label {
  font-size: 12px;
  color: var(--text-secondary);
}

.dialog-hint {
  margin: 0;
  font-size: 13px;
  color: var(--text-secondary);
}

.dialog-footer {
  display: flex;
  justify-content: flex-end;
  gap: var(--space-2);
  margin-top: var(--space-4);
}

@media (min-width: 769px) {
  .filter-input {
    width: 200px;
  }

  .filter-select {
    width: 150px;
  }

  .pagination-row {
    justify-content: flex-end;
  }
}
</style>
