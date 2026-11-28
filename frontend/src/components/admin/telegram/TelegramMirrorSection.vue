<template>
  <div>
    <!-- 镜像规则卡：多规则列表 + 新建/编辑 -->
    <section id="tg-mirror" class="card" aria-label="镜像规则">
      <div class="section-header">
        <h3>镜像规则</h3>
        <div class="section-actions">
          <span class="section-hint-inline">
            当前主群：{{ mirror?.mainChatId || '未配置' }}
          </span>
          <t-button theme="primary" size="small" @click="openCreateRule">新建规则</t-button>
        </div>
      </div>

      <p class="section-hint">
        扩散链路：持有源消息的 Bot 先转发到「主群」，再由用户账号从主群服务端转发到各「镜像群」，
        最后由镜像群内的各存储 Bot 认领自己的副本。所有**启用中**的规则必须共用同一个主群；
        每条启用规则对应一个独立的镜像群，各自独立任务、重试与状态。全程零字节重传，不存在 Bot 重新上传。
      </p>

      <t-alert
        v-if="mirror && mirror.rules.length > 1 && !mirror.mainChatId"
        theme="warning"
        message="启用中的多条规则主群不一致：所有启用规则必须共用同一个主群（源群），否则同一文件会被搬运多次。"
      />

      <div v-if="mirror && mirror.rules.length > 0" class="mirror-rule-list">
        <div v-for="rule in mirror.rules" :key="rule.id" class="mirror-rule-row">
          <div class="mirror-rule-head">
            <span class="cell-strong">{{ rule.name || '未命名规则' }}</span>
            <t-tag :theme="rule.enabled ? 'success' : 'default'" variant="light">
              {{ rule.enabled ? '已启用' : '未启用' }}
            </t-tag>
            <t-tag :theme="ruleTestTheme(rule.lastTestStatus)" variant="light">
              权限测试：{{ testStatusText(rule.lastTestStatus) }}
            </t-tag>
          </div>
          <div class="mirror-rule-meta">
            主群（源群，副本扩散中转落点）：<span class="cell-mono">{{ rule.sourceChatId || '—' }}</span>
          </div>
          <div class="mirror-rule-meta">
            镜像群（备份群）：<span class="cell-mono">{{ rule.targetChatId || '单群模式（主群内认领）' }}</span>
          </div>
          <div class="mirror-rule-meta">
            优先账号：{{ rule.preferredAccountId || '自动选择' }} · 事件范围：{{ ruleEventScopeText(rule) }}
          </div>
          <div v-if="rule.lastTestSummary" class="mirror-rule-meta cell-muted">
            测试摘要：{{ rule.lastTestSummary }}
          </div>
          <div class="mirror-rule-actions">
            <div class="mirror-rule-switch">
              <span class="field-label">启用该镜像群</span>
              <t-switch
                :value="rule.enabled"
                :loading="togglingRuleId === rule.id"
                :aria-label="`启用镜像规则 ${rule.name || rule.targetChatId}`"
                @change="(v: boolean) => toggleRuleEnabled(rule, Boolean(v))"
              />
            </div>
            <div class="mobile-card-actions">
              <t-button variant="text" size="small" :loading="testingRuleId === rule.id" @click="runMirrorTest(rule)">
                测试权限
              </t-button>
              <t-button variant="text" size="small" @click="openEditRule(rule)">编辑</t-button>
              <t-button variant="text" size="small" theme="danger" @click="confirmDeleteRule(rule)">删除</t-button>
            </div>
          </div>
        </div>
      </div>
      <div v-else class="empty-hint">尚未配置镜像规则</div>

      <div class="mirror-form">
        <div class="mirror-form-head">
          <span class="field-label">{{ mirrorForm.id ? '编辑规则' : '新建规则' }}</span>
          <span class="section-hint-inline">主群/镜像群变更后需重新执行权限测试才能启用</span>
        </div>
        <label class="field">
          <span class="field-label">规则名称</span>
          <t-input v-model="mirrorForm.name" placeholder="便于识别的名称" autocomplete="off" name="mirror-name" />
        </label>
        <label class="field">
          <span class="field-label">主群（源群，副本扩散中转落点）</span>
          <t-input v-model="mirrorForm.sourceChatId" placeholder="例如 -1001234567890" autocomplete="off" name="mirror-source" />
        </label>
        <label class="field">
          <span class="field-label">镜像群（备份群）</span>
          <t-input v-model="mirrorForm.targetChatId" placeholder="留空 = 单群模式（主群内各 Bot 自行认领副本，不做 userbot 转发）" autocomplete="off" name="mirror-target" />
        </label>
        <label class="field">
          <span class="field-label">优先账号（可空，留空自动选号）</span>
          <t-input v-model="mirrorForm.preferredAccountId" placeholder="留空自动选择" autocomplete="off" name="mirror-preferred-account" />
        </label>

        <div class="mirror-events">
          <span class="field-label">事件范围</span>
          <t-checkbox v-model="mirrorForm.includeWebUploads">Web 上传</t-checkbox>
          <t-checkbox v-model="mirrorForm.includeBotInboundFiles">Bot 入站</t-checkbox>
        </div>

        <div class="field field-actions">
          <t-button theme="primary" :loading="savingMirror" @click="saveMirrorRule">保存规则</t-button>
          <t-button v-if="mirrorForm.id" variant="outline" @click="resetMirrorForm">取消编辑</t-button>
        </div>
      </div>

      <t-alert theme="info" :message="mirrorModeHint" />

      <div v-if="mirrorTestResult" class="test-result">
        <div class="test-result-head">
          <t-tag :theme="mirrorTestResult.status === 'ok' ? 'success' : 'danger'" variant="light">
            {{ mirrorTestResult.status === 'ok' ? '测试通过' : '测试失败' }}
          </t-tag>
          <span class="test-result-summary">
            {{ mirrorTestResult.ruleName ? `「${mirrorTestResult.ruleName}」` : '' }}{{ mirrorTestResult.summary }}
          </span>
        </div>
        <ul class="test-details">
          <li v-for="(detail, index) in mirrorTestResult.details" :key="index" class="test-detail">
            <span class="test-detail-role">{{ detail.chat === 'source' ? '主群' : '镜像群' }}</span>
            <t-tag :theme="detail.ok ? 'success' : 'danger'" variant="light">{{ detail.ok ? '可用' : '不可用' }}</t-tag>
            <span class="test-detail-text">{{ detail.title || '—' }}{{ detail.type ? `（${detail.type}）` : '' }}</span>
            <span v-if="!detail.ok && detail.error" class="cell-error">{{ detail.error }}</span>
          </li>
        </ul>
      </div>
    </section>

    <!-- 历史补偿：把历史文件按批限速补做镜像备份 -->
    <section id="tg-backfill" class="card" aria-label="历史补偿">
      <div class="section-header">
        <h3>历史补偿</h3>
        <div class="section-actions">
          <t-button
            v-if="backfillIdle"
            theme="default"
            variant="outline"
            :loading="backfillSaving"
            @click="runBackfill('dry-run')"
          >
            评估影响面
          </t-button>
          <t-button v-if="backfillIdle" theme="primary" :loading="backfillSaving" @click="runBackfill('apply')">
            开始补偿
          </t-button>
          <t-button
            v-if="backfill.status === 'running'"
            :loading="backfillSaving"
            @click="controlBackfill('pause')"
          >
            暂停
          </t-button>
          <t-button
            v-if="backfill.status === 'paused'"
            :loading="backfillSaving"
            @click="controlBackfill('resume')"
          >
            恢复
          </t-button>
          <t-button
            v-if="backfill.status === 'running' || backfill.status === 'paused'"
            theme="danger"
            variant="outline"
            :loading="backfillSaving"
            @click="controlBackfill('cancel')"
          >
            取消
          </t-button>
        </div>
      </div>

      <div class="field-row">
        <span class="field-label">状态</span>
        <t-tag :theme="backfillStatusTheme" variant="light">{{ backfillStatusText }}</t-tag>
        <span class="field-label">模式</span>
        <span>{{ backfill.mode === 'apply' ? '实际入队' : '仅评估' }}</span>
        <span class="field-label">已扫描</span>
        <span>{{ backfill.scanned }}</span>
        <span class="field-label">已入队</span>
        <span>{{ backfill.queued }}</span>
        <span class="field-label">已跳过</span>
        <span>{{ backfill.skipped }}</span>
      </div>

      <p class="section-hint">
        补偿会为历史文件补齐「主群搬运 + 用户账号中继到各镜像群」的任务（全程服务端转发，不产生文件字节流量）：
        按批扫描（每批 20 个、间隔 1 秒），可随时暂停或取消；
        重复运行不会产生重复备份（任务幂等键保证），也不会改变现有下载链接。
      </p>

      <t-alert v-if="backfill.lastError" theme="warning" :message="backfill.lastError" />
      <div v-if="backfill.sample.length > 0" class="field-row">
        <span class="section-hint">样本文件 ID（最多 20 个）：</span>
        <code v-for="sampleId in backfill.sample" :key="sampleId" class="cell-mono">{{ sampleId }}</code>
      </div>
    </section>

    <!-- 任务列表区：按镜像群（targetChatId）分组，避免多群失败混成一锅 -->
    <section id="tg-tasks" class="card" aria-label="镜像任务">
      <div class="section-header">
        <h3>镜像任务</h3>
        <div class="section-actions">
          <span class="section-hint-inline">
            按镜像群分组：每条启用规则对应一个镜像群，各自独立任务/重试/状态
          </span>
        </div>
      </div>

      <div class="table-filters">
        <t-select v-model="taskFilters.status" class="filter-select" placeholder="状态">
          <t-option value="" label="全部状态" />
          <t-option value="queued" label="排队中" />
          <t-option value="running" label="执行中" />
          <t-option value="retrying" label="重试中" />
          <t-option value="succeeded" label="成功" />
          <t-option value="failed" label="失败" />
          <t-option value="blocked" label="阻塞" />
          <t-option value="cancelled" label="已取消" />
        </t-select>
        <t-input
          v-model="taskFilters.ownerId"
          class="filter-input"
          placeholder="主文件 ID"
          clearable
          autocomplete="off"
          name="mirror-owner-id"
          @enter="onTaskFilterChange"
          @clear="onTaskFilterChange"
        />
        <t-input
          v-model="taskFilters.accountId"
          class="filter-input"
          placeholder="账号 ID"
          clearable
          autocomplete="off"
          name="mirror-account-id"
          @enter="onTaskFilterChange"
          @clear="onTaskFilterChange"
        />
        <t-button variant="outline" :loading="tasksLoading" @click="onTaskFilterChange">查询</t-button>
      </div>

      <div v-if="!tasksLoading && taskRows.length === 0" class="empty-hint">暂无镜像任务</div>

      <div v-else class="task-groups">
        <div v-for="group in taskGroups" :key="group.key" class="task-group">
          <div class="task-group-head">
            <span class="cell-strong task-group-chat">
              镜像群：<span class="cell-mono">{{ group.chatId || '未归属（历史任务）' }}</span>
            </span>
            <span class="kv-note">{{ group.ruleLabel }}</span>
            <t-tag :theme="taskGroupTheme(group)" variant="light" size="small">
              失败 {{ group.failedCount }} · 阻塞 {{ group.blockedCount }} · 进行中 {{ group.pendingCount }}
            </t-tag>
          </div>

          <p v-if="group.lastErrorSummary" class="task-group-error">
            最近失败原因：{{ group.lastErrorSummary }}
            <span v-if="group.lastErrorCode" class="cell-mono">（{{ group.lastErrorCode }}）</span>
            <span v-if="group.lastErrorAt" class="cell-muted"> · {{ formatTime(group.lastErrorAt) }}</span>
          </p>
          <p v-else class="kv-note">该镜像群暂无失败记录</p>

          <div v-if="!isMobile" class="table-scroll">
            <t-table
              :data="group.items"
              :columns="taskColumns"
              :loading="tasksLoading"
              row-key="id"
              table-layout="fixed"
              :pagination="false"
              size="small"
            >
              <template #ownerId="{ row }">
                <span class="cell-mono">{{ row.ownerId }}</span>
              </template>
              <template #targetAccountId="{ row }">
                <span class="cell-mono">{{ row.targetAccountId || '—' }}</span>
              </template>
              <template #targetMessageId="{ row }">{{ row.targetMessageId || '—' }}</template>
              <template #attempts="{ row }">{{ row.attempts }}</template>
              <template #lastError="{ row }">
                <span v-if="row.lastErrorSummary" class="cell-error">{{ row.lastErrorSummary }}</span>
                <span v-else class="cell-muted">—</span>
              </template>
              <template #time="{ row }">{{ formatTime(row.updatedAt || row.createdAt) }}</template>
              <template #operations="{ row }">
                <div class="row-actions">
                  <t-button
                    v-if="canRetry(row)"
                    variant="text"
                    size="small"
                    @click="doRetryTask(row)"
                  >
                    重试
                  </t-button>
                  <t-button
                    v-if="canCancel(row)"
                    variant="text"
                    theme="danger"
                    size="small"
                    @click="doCancelTask(row)"
                  >
                    取消
                  </t-button>
                  <t-tooltip v-if="isRunning(row)" content="执行中不可取消">
                    <span class="disabled-action">取消</span>
                  </t-tooltip>
                </div>
              </template>
            </t-table>
          </div>

          <div v-else class="mobile-card-list">
            <div v-for="row in group.items" :key="row.id" class="mobile-task-card">
              <div class="mobile-card-head">
                <span class="cell-mono">{{ row.ownerId }}</span>
                <t-tag :theme="taskStatusTheme(row.status)" variant="light">{{ taskStatusText(row.status) }}</t-tag>
              </div>
              <div class="mobile-card-meta">执行账号：{{ row.targetAccountId || '—' }}</div>
              <div class="mobile-card-meta">目标消息：{{ row.targetMessageId || '—' }} · 重试 {{ row.attempts }}</div>
              <div v-if="row.lastErrorSummary" class="mobile-card-meta cell-error">错误：{{ row.lastErrorSummary }}</div>
              <div class="mobile-card-meta">{{ formatTime(row.updatedAt || row.createdAt) }}</div>
              <div class="mobile-card-actions">
                <t-button v-if="canRetry(row)" variant="text" size="small" @click="doRetryTask(row)">重试</t-button>
                <t-button v-if="canCancel(row)" variant="text" theme="danger" size="small" @click="doCancelTask(row)">取消</t-button>
                <span v-if="isRunning(row)" class="disabled-action">执行中不可取消</span>
              </div>
            </div>
          </div>
        </div>
      </div>

      <div class="pagination-row">
        <t-pagination
          :current="taskPagination.current"
          :total="taskPagination.total"
          :page-size="taskPagination.pageSize"
          :page-size-options="[10, 20, 50]"
          size="small"
          @change="onTaskPageChange"
        />
      </div>
    </section>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, onUnmounted, reactive, ref } from 'vue';
import { DialogPlugin } from 'tdesign-vue-next/es/dialog';
import MessagePlugin from '@/utils/message';
import { getErrorMessage } from '@/utils/error';
import { useMobile } from '@/composables/useMobile';
import {
  cancelMirrorBackfill,
  cancelMirrorTask,
  createMirrorRule,
  deleteMirrorRule,
  fetchMirrorBackfill,
  fetchMirrorTasks,
  pauseMirrorBackfill,
  resumeMirrorBackfill,
  retryMirrorTask,
  setMirrorRuleEnabled,
  startMirrorBackfill,
  testMirrorRule,
  updateMirrorRule,
  type MirrorBackfillJob,
  type MirrorBackfillStatus,
  type MirrorOverview,
  type MirrorRule,
  type MirrorRuleTestResult,
  type MirrorTaskListItem,
  type TelegramMirrorTaskStatus,
  type UpdateMirrorRuleInput,
} from '@/api/telegram-accounts';
import { formatTime, testStatusText } from '@/utils/telegram-format';

const props = defineProps<{
  mirror: MirrorOverview | null;
}>();

const emit = defineEmits<{
  'refresh-mirror': [];
}>();

const isMobile = useMobile();

const emptyBackfill = (): MirrorBackfillJob => ({
  status: 'idle',
  mode: 'dry-run',
  limit: 0,
  scanned: 0,
  queued: 0,
  skipped: 0,
  sample: [],
  startedAt: null,
  updatedAt: '',
  finishedAt: null,
  lastError: null,
  cursor: null,
});

const backfill = ref<MirrorBackfillJob>(emptyBackfill());
const backfillSaving = ref(false);
const backfillIdle = computed(() => ['idle', 'completed', 'cancelled', 'failed'].includes(backfill.value.status));

const BACKFILL_STATUS_TEXT: Record<MirrorBackfillStatus, string> = {
  idle: '未开始',
  running: '执行中',
  paused: '已暂停',
  completed: '已完成',
  cancelled: '已取消',
  failed: '失败',
};

const BACKFILL_STATUS_THEME: Record<MirrorBackfillStatus, 'default' | 'primary' | 'success' | 'warning' | 'danger'> = {
  idle: 'default',
  running: 'primary',
  paused: 'warning',
  completed: 'success',
  cancelled: 'default',
  failed: 'danger',
};

const backfillStatusText = computed(() => BACKFILL_STATUS_TEXT[backfill.value.status] ?? '未知');
const backfillStatusTheme = computed(() => BACKFILL_STATUS_THEME[backfill.value.status] ?? 'default');

let backfillTimer: ReturnType<typeof setInterval> | null = null;

function syncBackfillPolling(): void {
  if (backfill.value.status === 'running' && !backfillTimer) {
    backfillTimer = setInterval(() => void loadBackfill(), 3000);
    return;
  }
  if (backfill.value.status !== 'running' && backfillTimer) {
    clearInterval(backfillTimer);
    backfillTimer = null;
  }
}

async function loadBackfill(signal?: AbortSignal): Promise<void> {
  try {
    backfill.value = await fetchMirrorBackfill(signal);
    syncBackfillPolling();
  } catch {
    // 补偿状态接口失败不阻断页面其余部分
  }
}

async function runBackfill(mode: 'dry-run' | 'apply'): Promise<void> {
  const dialog = DialogPlugin.confirm({
    header: mode === 'dry-run' ? '评估历史补偿影响面' : '开始历史补偿',
    body: mode === 'dry-run'
      ? '仅统计将被补偿的历史文件数量，不入队、不产生任何转发。'
      : '补偿会为历史文件补建「主群搬运 + 用户账号中继到各镜像群」的任务：按批限速执行、可随时暂停或取消；'
        + '全程服务端转发，不产生文件字节流量；重复运行不会产生重复备份。',
    onConfirm: async () => {
      dialog.destroy();
      backfillSaving.value = true;
      try {
        const result = await startMirrorBackfill({ mode, limit: 200 });
        MessagePlugin.success(result.message);
        backfill.value = result.job;
        syncBackfillPolling();
      } catch (error) {
        MessagePlugin.error(getErrorMessage(error));
      } finally {
        backfillSaving.value = false;
      }
    },
    onClose: () => dialog.destroy(),
  });
}

async function controlBackfill(action: 'pause' | 'resume' | 'cancel'): Promise<void> {
  backfillSaving.value = true;
  try {
    const result = action === 'pause'
      ? await pauseMirrorBackfill()
      : action === 'resume'
        ? await resumeMirrorBackfill()
        : await cancelMirrorBackfill();
    MessagePlugin.success(result.message);
    backfill.value = result.job;
    syncBackfillPolling();
  } catch (error) {
    MessagePlugin.error(getErrorMessage(error));
  } finally {
    backfillSaving.value = false;
  }
}

interface MirrorRuleFormState {
  id: string | null;
  name: string;
  sourceChatId: string;
  targetChatId: string;
  preferredAccountId: string;
  includeWebUploads: boolean;
  includeBotInboundFiles: boolean;
}

function emptyMirrorForm(): MirrorRuleFormState {
  return {
    id: null,
    name: '',
    sourceChatId: '',
    targetChatId: '',
    preferredAccountId: '',
    includeWebUploads: true,
    includeBotInboundFiles: true,
  };
}

const mirrorForm = reactive<MirrorRuleFormState>(emptyMirrorForm());
const mirrorTestResult = ref<(MirrorRuleTestResult & { ruleName: string }) | null>(null);
const testingRuleId = ref<string | null>(null);
const togglingRuleId = ref<string | null>(null);
const savingMirror = ref(false);

const mirrorModeHint =
  '扩散只有一条链路：持有源消息的 Bot 先转发到主群，再由用户账号从主群服务端转发到各镜像群，'
  + '最后由镜像群内的 Bot 认领副本；全程零字节重传（字节二次传输恒为 0），'
  + '不存在 Bot 重新上传，也不作为失败降级手段。';

function resetMirrorForm() {
  Object.assign(mirrorForm, emptyMirrorForm());
}

function openCreateRule() {
  resetMirrorForm();
}

function openEditRule(rule: MirrorRule) {
  mirrorForm.id = rule.id;
  mirrorForm.name = rule.name ?? '';
  mirrorForm.sourceChatId = rule.sourceChatId ?? '';
  mirrorForm.targetChatId = rule.targetChatId ?? '';
  mirrorForm.preferredAccountId = rule.preferredAccountId ?? '';
  mirrorForm.includeWebUploads = rule.includeWebUploads;
  mirrorForm.includeBotInboundFiles = rule.includeBotInboundFiles;
}

function ruleEventScopeText(rule: MirrorRule): string {
  const parts: string[] = [];
  if (rule.includeWebUploads) parts.push('Web 上传');
  if (rule.includeBotInboundFiles) parts.push('Bot 入站');
  return parts.length > 0 ? parts.join(' / ') : '未选择事件';
}

function ruleTestTheme(status: MirrorRule['lastTestStatus']): 'success' | 'warning' | 'danger' | 'default' {
  if (status === 'ok') return 'success';
  if (status === 'failed') return 'danger';
  return 'default';
}

async function runMirrorTest(rule: MirrorRule) {
  testingRuleId.value = rule.id;
  try {
    const result = await testMirrorRule(rule.id);
    mirrorTestResult.value = { ...result, ruleName: rule.name };
    if (result.status === 'ok') {
      MessagePlugin.success(result.summary || '测试通过');
    } else {
      MessagePlugin.error(result.summary || '测试失败');
    }
    emit('refresh-mirror');
  } catch (error) {
    MessagePlugin.error(getErrorMessage(error));
  } finally {
    testingRuleId.value = null;
  }
}

async function saveMirrorRule() {
  if (!mirrorForm.sourceChatId.trim()) {
    MessagePlugin.warning('请填写主群');
    return;
  }
  if (mirrorForm.targetChatId.trim() && mirrorForm.targetChatId.trim() === mirrorForm.sourceChatId.trim()) {
    MessagePlugin.warning('镜像群不能与主群相同：单群请留空镜像群');
    return;
  }
  savingMirror.value = true;
  try {
    const payload: UpdateMirrorRuleInput = {
      name: mirrorForm.name.trim() || undefined,
      sourceChatId: mirrorForm.sourceChatId.trim(),
      targetChatId: mirrorForm.targetChatId.trim(),
      preferredAccountId: mirrorForm.preferredAccountId.trim(),
      includeWebUploads: mirrorForm.includeWebUploads,
      includeBotInboundFiles: mirrorForm.includeBotInboundFiles,
    };
    const result = mirrorForm.id
      ? await updateMirrorRule(mirrorForm.id, payload)
      : await createMirrorRule(payload);
    MessagePlugin.success(result.message);
    emit('refresh-mirror');
    resetMirrorForm();
  } catch (error) {
    MessagePlugin.error(getErrorMessage(error));
  } finally {
    savingMirror.value = false;
  }
}

async function toggleRuleEnabled(rule: MirrorRule, enabled: boolean) {
  if (enabled && rule.lastTestStatus !== 'ok') {
    MessagePlugin.warning('启用规则前请先通过「测试权限」');
    return;
  }
  togglingRuleId.value = rule.id;
  try {
    const result = await setMirrorRuleEnabled(rule.id, enabled);
    MessagePlugin.success(result.message);
    emit('refresh-mirror');
  } catch (error) {
    MessagePlugin.error(getErrorMessage(error));
    emit('refresh-mirror');
  } finally {
    togglingRuleId.value = null;
  }
}

function confirmDeleteRule(rule: MirrorRule) {
  const dialog = DialogPlugin.confirm({
    header: '删除镜像规则',
    body: `确定删除规则「${rule.name || '未命名规则'}」吗？删除后该镜像群不再参与副本扩散，已备份内容不会被删除。`,
    theme: 'danger',
    onConfirm: async () => {
      dialog.destroy();
      try {
        const result = await deleteMirrorRule(rule.id);
        MessagePlugin.success(result.message);
        if (mirrorForm.id === rule.id) resetMirrorForm();
        emit('refresh-mirror');
      } catch (error) {
        MessagePlugin.error(getErrorMessage(error));
      }
    },
    onClose: () => dialog.destroy(),
  });
}

const taskRows = ref<MirrorTaskListItem[]>([]);
const tasksLoading = ref(false);
const taskFilters = reactive<{
  status: TelegramMirrorTaskStatus | '';
  ownerId: string;
  accountId: string;
}>({
  status: '',
  ownerId: '',
  accountId: '',
});
const taskPagination = reactive({ current: 1, pageSize: 20, total: 0 });

const taskColumns = [
  { colKey: 'ownerId', title: '文件 ID', width: 200 },
  { colKey: 'targetAccountId', title: '执行账号', width: 150 },
  { colKey: 'targetMessageId', title: '目标消息', width: 120 },
  { colKey: 'attempts', title: '重试', width: 70 },
  { colKey: 'lastError', title: '最后错误', width: 220 },
  { colKey: 'time', title: '时间', width: 160 },
  { colKey: 'operations', title: '操作', width: 140 },
];

interface TaskGroup {
  key: string;
  chatId: string | null;
  ruleLabel: string;
  items: MirrorTaskListItem[];
  failedCount: number;
  blockedCount: number;
  pendingCount: number;
  lastErrorCode: string | null;
  lastErrorSummary: string | null;
  lastErrorAt: string | null;
}

const PENDING_TASK_STATUSES: TelegramMirrorTaskStatus[] = ['queued', 'running', 'retrying'];

const taskGroups = computed<TaskGroup[]>(() => {
  const ruleNames = new Map<string, string>(
    (props.mirror?.rules ?? []).map((rule) => [rule.id, rule.name || '未命名规则']),
  );
  const groups = new Map<string, TaskGroup>();

  for (const item of taskRows.value) {
    const chatId = (item.targetChatId || '').trim() || null;
    const key = chatId ?? '__unassigned__';
    let group = groups.get(key);
    if (!group) {
      group = {
        key,
        chatId,
        ruleLabel: ruleNames.get(item.ruleId) ?? (item.ruleId ? `规则 ${item.ruleId}` : '未知规则'),
        items: [],
        failedCount: 0,
        blockedCount: 0,
        pendingCount: 0,
        lastErrorCode: null,
        lastErrorSummary: null,
        lastErrorAt: null,
      };
      groups.set(key, group);
    }
    group.items.push(item);
    if (item.status === 'failed') group.failedCount += 1;
    if (item.status === 'blocked') group.blockedCount += 1;
    if (PENDING_TASK_STATUSES.includes(item.status)) group.pendingCount += 1;
    if (item.lastErrorSummary && group.lastErrorSummary === null) {
      group.lastErrorCode = item.lastErrorCode;
      group.lastErrorSummary = item.lastErrorSummary;
      group.lastErrorAt = item.updatedAt || item.createdAt;
    }
  }

  return [...groups.values()].sort((left, right) => {
    const bad = (group: TaskGroup) => group.failedCount + group.blockedCount;
    if (bad(right) !== bad(left)) return bad(right) - bad(left);
    return (left.chatId ?? '').localeCompare(right.chatId ?? '');
  });
});

type TagTheme = 'default' | 'primary' | 'success' | 'warning' | 'danger';

function taskGroupTheme(group: TaskGroup): TagTheme {
  if (group.failedCount + group.blockedCount > 0) return 'danger';
  if (group.pendingCount > 0) return 'primary';
  return 'default';
}

const TASK_STATUS_TEXT: Record<TelegramMirrorTaskStatus, string> = {
  queued: '排队中',
  running: '执行中',
  retrying: '重试中',
  succeeded: '成功',
  failed: '失败',
  blocked: '阻塞',
  cancelled: '已取消',
};

const TASK_STATUS_THEME: Record<TelegramMirrorTaskStatus, TagTheme> = {
  queued: 'default',
  running: 'primary',
  retrying: 'warning',
  succeeded: 'success',
  failed: 'danger',
  blocked: 'danger',
  cancelled: 'default',
};

function taskStatusText(status: TelegramMirrorTaskStatus): string {
  return TASK_STATUS_TEXT[status] ?? status;
}

function taskStatusTheme(status: TelegramMirrorTaskStatus): TagTheme {
  return TASK_STATUS_THEME[status] ?? 'default';
}

function isRunning(row: MirrorTaskListItem): boolean {
  return row.status === 'running';
}

function canRetry(row: MirrorTaskListItem): boolean {
  return row.status === 'failed' || row.status === 'blocked' || row.status === 'cancelled';
}

function canCancel(row: MirrorTaskListItem): boolean {
  return row.status === 'queued' || row.status === 'retrying';
}

async function loadTasks() {
  tasksLoading.value = true;
  try {
    const { items, total } = await fetchMirrorTasks({
      status: taskFilters.status || undefined,
      ownerId: taskFilters.ownerId.trim() || undefined,
      accountId: taskFilters.accountId.trim() || undefined,
      page: taskPagination.current,
      pageSize: taskPagination.pageSize,
    });
    taskRows.value = items;
    taskPagination.total = total;
  } catch {
    MessagePlugin.error('任务列表加载失败，已保留上次数据');
  } finally {
    tasksLoading.value = false;
  }
}

function onTaskFilterChange() {
  taskPagination.current = 1;
  loadTasks();
}

function onTaskPageChange(pageInfo: { current: number; pageSize: number }) {
  taskPagination.current = pageInfo.current;
  taskPagination.pageSize = pageInfo.pageSize;
  loadTasks();
}

async function doRetryTask(row: MirrorTaskListItem) {
  try {
    const result = await retryMirrorTask(row.id);
    MessagePlugin.success(result.message);
    emit('refresh-mirror');
    await loadTasks();
  } catch (error) {
    MessagePlugin.error(getErrorMessage(error));
  }
}

async function doCancelTask(row: MirrorTaskListItem) {
  if (row.status === 'running') {
    MessagePlugin.warning('执行中不可取消');
    return;
  }
  try {
    const result = await cancelMirrorTask(row.id);
    MessagePlugin.success(result.message);
    emit('refresh-mirror');
    await loadTasks();
  } catch (error) {
    MessagePlugin.error(getErrorMessage(error));
  }
}

onMounted(() => {
  void loadTasks();
  void loadBackfill();
});

onUnmounted(() => {
  if (backfillTimer) {
    clearInterval(backfillTimer);
    backfillTimer = null;
  }
});
</script>

<style scoped>
.section-hint-inline {
  font-size: 12px;
  color: var(--text-tertiary);
}

.filter-input,
.filter-select {
  width: 100%;
}

.pagination-row {
  justify-content: center;
}

.cell-strong { font-weight: 600; color: var(--text-primary); }
.cell-mono { font-family: var(--font-mono); font-size: 12px; color: var(--text-secondary); }
.cell-muted { color: var(--text-tertiary); }
.cell-error { color: var(--color-danger); font-size: 12px; }
.kv-note { font-size: 12px; color: var(--text-secondary); word-break: break-all; }

.row-actions {
  display: flex;
  gap: var(--space-1);
  flex-wrap: wrap;
}

.disabled-action {
  font-size: 12px;
  color: var(--text-disabled);
}

.mirror-rule-list {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
  margin-bottom: var(--space-4);
}

.mirror-rule-row {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
  padding: var(--space-3) var(--space-4);
  background: var(--color-bg-elevated);
  border: 1px solid var(--border-default);
  border-radius: var(--radius-md);
}

.mirror-rule-head {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  flex-wrap: wrap;
}

.mirror-rule-meta {
  font-size: 12px;
  color: var(--text-secondary);
  word-break: break-all;
}

.mirror-rule-actions {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-3);
  flex-wrap: wrap;
  margin-top: var(--space-1);
}

.mirror-rule-switch {
  display: flex;
  align-items: center;
  gap: var(--space-2);
}

.mirror-form {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(min(100%, 220px), 1fr));
  gap: var(--space-3);
  align-items: end;
  margin-bottom: var(--space-4);
}

.mirror-form-head {
  grid-column: 1 / -1;
  display: flex;
  align-items: baseline;
  gap: var(--space-3);
  flex-wrap: wrap;
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

.field-actions {
  flex-direction: row;
  gap: var(--space-2);
}

.mirror-events {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  flex-wrap: wrap;
  margin-bottom: var(--space-4);
}

.test-result {
  margin-top: var(--space-4);
  padding: var(--space-3) var(--space-4);
  border: 1px solid var(--border-default);
  border-radius: var(--radius-md);
  background: var(--color-bg-elevated);
}

.test-result-head {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  flex-wrap: wrap;
}

.test-result-summary {
  font-size: 13px;
  color: var(--text-primary);
}

.test-details {
  list-style: none;
  margin: var(--space-3) 0 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}

.test-detail {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  flex-wrap: wrap;
  font-size: 13px;
}

.test-detail-role {
  font-weight: 600;
  color: var(--text-primary);
}

.test-detail-text {
  color: var(--text-secondary);
}

.task-groups {
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
}

.task-group {
  border: 1px solid var(--border-default);
  border-radius: var(--radius-md);
  background: var(--color-bg-elevated);
  padding: var(--space-3);
}

.task-group-head {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  flex-wrap: wrap;
  margin-bottom: var(--space-2);
}

.task-group-chat {
  word-break: break-all;
}

.task-group-error {
  margin: 0 0 var(--space-2);
  font-size: 12px;
  color: var(--color-danger);
  line-height: 1.7;
  word-break: break-all;
}

.mobile-task-card {
  background: var(--color-bg-surface);
  border: 1px solid var(--border-default);
  border-radius: var(--radius-md);
  padding: var(--space-3);
}

.mobile-task-card + .mobile-task-card {
  margin-top: var(--space-3);
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
