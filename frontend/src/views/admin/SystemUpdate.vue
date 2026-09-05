<template>
  <div class="page-container system-update">
    <div class="page-header">
      <h1>系统更新</h1>
      <p>
        检查、确认并安装稳定版本更新；安装前自动完成可信校验、备份与迁移，失败自动回退。
        <t-tag v-if="status && !status.installEnabled" theme="warning" variant="light" size="small" class="header-tag">
          安装入口未开放（UPDATE_INSTALL_ENABLED=false）
        </t-tag>
      </p>
    </div>

    <!-- 版本状态卡片区 -->
    <div class="version-cards">
      <div class="version-card">
        <h3>当前版本</h3>
        <div class="value mono">{{ status?.currentVersion ?? '—' }}</div>
        <div class="hint">stable 通道</div>
      </div>
      <div class="version-card">
        <h3>最新稳定版</h3>
        <div class="value mono">{{ latestVersionText }}</div>
        <div class="hint">{{ latestHint }}</div>
      </div>
      <div class="version-card">
        <h3>最后检查</h3>
        <div class="value mono small">{{ lastCheckText }}</div>
        <div class="hint">{{ statusText }}</div>
      </div>
    </div>

    <!-- 状态横幅 -->
    <t-alert
      v-if="banner"
      :theme="banner.theme"
      :message="banner.message"
      :class="{ 'stale-banner': banner.stale }"
    />

    <!-- 活动任务进度 -->
    <div v-if="activeTask" class="glass-card progress-card">
      <div class="card-title-row">
        <h2>更新进行中</h2>
        <t-tag :theme="taskTagTheme(activeTask.status)" variant="light" size="small">
          {{ stageLabel(activeTask.status) }}
        </t-tag>
        <t-button
          v-if="isCancellable(activeTask.status)"
          variant="outline" theme="danger" size="small"
          :loading="cancelling"
          @click="confirmCancelTask"
        >
          取消更新
        </t-button>
      </div>
      <div class="stage-steps">
        <div
          v-for="stage in visibleStages"
          :key="stage.status"
          class="stage-step"
          :class="{ done: stage.done, current: stage.current, failed: stage.failed }"
        >
          <span class="stage-dot" />
          <span class="stage-label">{{ stage.label }}</span>
        </div>
      </div>
      <t-progress
        :percentage="activeTask.progress"
        :status="progressStatus"
        :stroke-width="8"
      />
      <div class="task-meta">
        <span>任务 {{ activeTask.taskId.slice(0, 8) }}</span>
        <span v-if="activeTask.startedAt">开始于 {{ formatTime(activeTask.startedAt) }}</span>
        <span>目标版本 <span class="mono">{{ activeTask.targetVersion }}</span></span>
        <span v-if="activeTask.errorSummary" class="error-text">{{ activeTask.errorSummary }}</span>
      </div>
      <t-alert
        v-if="reconnecting"
        theme="warning"
        message="与后端的连接中断，正在自动重连（指数退避）；任务在后端持续执行，恢复后将续接当前进度。"
      />
    </div>

    <!-- 候选发行信息 -->
    <div v-if="candidate" class="glass-card candidate-card">
      <div class="card-title-row">
        <h2>可用更新 · v{{ candidate.version }}</h2>
        <t-tag theme="primary" variant="light" size="small">stable</t-tag>
        <t-tag v-if="!candidate.compatible" theme="danger" variant="light" size="small">不可自动升级</t-tag>
      </div>
      <div class="candidate-meta">
        <div><label>发布时间</label><span>{{ formatTime(candidate.publishedAt) }}</span></div>
        <div><label>制品</label><span class="mono">{{ candidate.asset.name }}</span></div>
        <div><label>大小</label><span class="mono">{{ formatSize(candidate.asset.size) }}</span></div>
        <div>
          <label>兼容性</label>
          <span>
            <template v-if="candidate.compatible">允许从当前版本自动升级</template>
            <template v-else>{{ compatibilityText }}</template>
          </span>
        </div>
        <div>
          <label>数据库迁移</label>
          <span>{{ candidate.manifest.includesDbMigration ? '包含迁移（自动先备份）' : '不含数据库迁移' }}</span>
        </div>
        <div>
          <label>程序回退</label>
          <span>{{ candidate.manifest.programRollbackSafe ? '失败可自动回退' : '不支持自动回退' }}</span>
        </div>
      </div>
      <details v-if="candidate.releaseNotes" class="release-notes">
        <summary>发行说明</summary>
        <pre class="notes-body">{{ candidate.releaseNotes }}</pre>
      </details>
      <div class="action-row">
        <t-button theme="default" variant="outline" :loading="checking" @click="onCheck">
          检查更新
        </t-button>
        <t-tooltip :content="installDisabledReason" :disabled="canInstall">
          <span>
            <t-button theme="primary" :disabled="!canInstall" :loading="installing" @click="confirmOpen = true">
              下载并安装
            </t-button>
          </span>
        </t-tooltip>
      </div>
    </div>

    <!-- 无候选时的操作区 -->
    <div v-if="!candidate && status" class="glass-card action-row standalone">
      <t-button theme="default" variant="outline" :loading="checking" @click="onCheck">
        检查更新
      </t-button>
    </div>

    <!-- 历史任务 -->
    <div class="glass-card history-card">
      <h2>最近更新任务</h2>
      <t-table
        v-if="tasks.length > 0"
        :data="tasks"
        :columns="taskColumns"
        row-key="taskId"
        size="small"
      >
        <template #status="{ row }">
          <t-tag :theme="taskTagTheme(row.status)" variant="light" size="small">
            {{ stageLabel(row.status) }}
          </t-tag>
        </template>
        <template #startedAt="{ row }">
          {{ row.startedAt ? formatTime(row.startedAt) : '—' }}
        </template>
      </t-table>
      <div v-else class="empty-hint">暂无更新任务记录。</div>
    </div>

    <!-- 安装二次确认 -->
    <t-dialog
      :visible="confirmOpen"
      header="确认安装系统更新"
      :confirm-btn="{ content: '确认安装', theme: 'primary', loading: installing }"
      :cancel-btn="{ content: '取消' }"
      width="520px"
      @confirm="onInstall"
      @close="confirmOpen = false"
    >
      <div class="confirm-body">
        <p>
          将系统从 <b class="mono">{{ status?.currentVersion }}</b>
          升级到 <b class="mono">v{{ candidate?.version }}</b>。
        </p>
        <ul>
          <li>升级过程中服务将短暂不可用（重启 + 健康检查）。</li>
          <li v-if="candidate?.manifest.includesDbMigration">此版本包含数据库迁移，已自动先备份；<b>数据库迁移不做自动逆向</b>。</li>
          <li>安装前会重新核验候选版本、摘要与签名，任何校验失败都会拒绝安装。</li>
          <li v-if="!candidate?.manifest.programRollbackSafe">此版本不支持自动程序回退，激活失败需要人工介入。</li>
        </ul>
        <p class="confirm-warn">确认执行后无法仅在前端撤回；请确认当前处于维护窗口。</p>
      </div>
    </t-dialog>
  </div>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import MessagePlugin from '@/utils/message';
import {
  cancelUpdateTask,
  checkUpdate,
  fetchUpdateStatus,
  fetchUpdateTasks,
  installUpdate,
} from '../../api/update';
import type { UpdateStatusResponse, UpdateTaskSummary } from '../../types/update';
import {
  UPDATE_COMPATIBILITY_TEXT,
  UPDATE_FAILURE_REASON_TEXT,
  UPDATE_FORWARD_STAGES,
  UPDATE_STAGE_LABELS,
} from '../../types/update';
import type { UpdateCandidate, UpdateTaskStatus } from '../../types/update';

// ---- 状态 ----
const status = ref<UpdateStatusResponse | null>(null);
const tasks = ref<UpdateTaskSummary[]>([]);
const checking = ref(false);
const installing = ref(false);
const cancelling = ref(false);
const confirmOpen = ref(false);
const reconnecting = ref(false);

// 指数退避轮询（仅活动任务存在时）
const POLL_BASE_MS = 1000;
const POLL_MAX_MS = 15000;
let pollTimer: ReturnType<typeof setTimeout> | null = null;
let pollDelay = POLL_BASE_MS;
let activeTaskId: string | null = null;

const candidate = computed<UpdateCandidate | null>(() => status.value?.candidate ?? null);
const activeTask = computed<UpdateTaskSummary | null>(() => status.value?.activeTask ?? null);

const latestVersionText = computed(() => {
  if (!status.value) return '—';
  return status.value.latestStableVersion
    ? `v${status.value.latestStableVersion}`
    : '未知';
});

const latestHint = computed(() => {
  if (!status.value) return '';
  if (status.value.stale) return '使用缓存结果';
  if (status.value.status === 'up_to_date') return '已是最新';
  if (status.value.status === 'update_available') return '有可用更新';
  return '';
});

const lastCheckText = computed(() => {
  if (!status.value) return '—';
  return status.value.checkedAt ? formatTime(status.value.checkedAt) : '—';
});

const statusText = computed(() => {
  if (!status.value) return '';
  if (status.value.status === 'disabled') return '更新检查未启用';
  if (status.value.stale) return `检查失败：${failureText(status.value.reason)}`;
  if (status.value.status === 'error') return `检查失败：${failureText(status.value.reason)}`;
  if (status.value.lastSuccessfulCheckAt) return '成功';
  return '尚未完成过检查';
});

const banner = computed(() => {
  const s = status.value;
  if (!s) return null;
  if (s.status === 'disabled') return { theme: 'info' as const, message: '更新检查未启用（UPDATE_CHECK_ENABLED=false）。', stale: false };
  if (s.status === 'update_available' && !s.stale) {
    return { theme: 'success' as const, message: `发现新版本 v${s.candidate?.version ?? s.latestStableVersion}，请确认发行说明后安装。`, stale: false };
  }
  if (s.stale) {
    return {
      theme: 'warning' as const,
      message: `检查失败（${failureText(s.reason)}），以下为 ${formatTime(s.lastSuccessfulCheckAt ?? s.checkedAt)} 的缓存结果。`,
      stale: true,
    };
  }
  if (s.status === 'error') {
    return { theme: 'error' as const, message: `检查失败：${failureText(s.reason)}`, stale: false };
  }
  if (s.status === 'up_to_date') return { theme: 'success' as const, message: '当前已是最新稳定版。', stale: false };
  return null;
});

const canInstall = computed(() => {
  const s = status.value;
  if (!s || !s.installEnabled) return false;
  if (s.activeTask) return false;
  return !!candidate.value?.compatible;
});

const installDisabledReason = computed(() => {
  const s = status.value;
  if (!s) return '';
  if (!s.installEnabled) return '安装入口未开放（UPDATE_INSTALL_ENABLED=false）';
  if (s.activeTask) return '已有进行中的更新任务';
  if (candidate.value && !candidate.value.compatible) return compatibilityText.value;
  return '';
});

const compatibilityText = computed(() => {
  const reason = candidate.value?.compatibilityReason;
  return reason ? (UPDATE_COMPATIBILITY_TEXT[reason] ?? '候选与当前版本不兼容') : '候选与当前版本不兼容';
});

// ---- 进度条阶段 ----
const visibleStages = computed(() => {
  const task = activeTask.value;
  if (!task) return [];
  const rollbackFlow: UpdateTaskStatus[] = ['rollback_pending', 'rolling_back', 'rolled_back', 'rollback_failed'];
  const inRollback = rollbackFlow.includes(task.status);
  const flow: UpdateTaskStatus[] = inRollback ? rollbackFlow : [...UPDATE_FORWARD_STAGES];
  const currentIndex = flow.indexOf(task.status);
  return flow.map((statusName, index) => ({
    status: statusName,
    label: UPDATE_STAGE_LABELS[statusName],
    done: currentIndex >= 0 ? index < currentIndex : false,
    current: index === currentIndex,
    failed: statusName === task.status && (statusName === 'rollback_failed' || statusName === 'rolled_back'),
  }));
});

const progressStatus = computed(() => {
  const s = activeTask.value?.status;
  if (s === 'rollback_failed') return 'error' as const;
  if (s === 'rolled_back' || s === 'cancelled') return 'warning' as const;
  if (s === 'succeeded') return 'success' as const;
  return 'active' as const;
});

// ---- 数据加载与轮询 ----
async function loadStatus(): Promise<void> {
  const next = await fetchUpdateStatus();
  status.value = next;
  const active = next.activeTask;
  if (active) {
    // 活动 task 切换时重置退避；后端不可达时按指数退避重连。
    if (active.taskId !== activeTaskId) {
      activeTaskId = active.taskId;
      pollDelay = POLL_BASE_MS;
    }
    schedulePoll();
  } else {
    activeTaskId = null;
    reconnecting.value = false;
    stopPoll();
  }
}

function schedulePoll(): void {
  stopPoll();
  pollTimer = setTimeout(async () => {
    try {
      await loadStatus();
      reconnecting.value = false;
      pollDelay = POLL_BASE_MS;
    } catch {
      // 后端升级重启期间：指数退避重连，恢复后自动续接原任务。
      reconnecting.value = true;
      pollDelay = Math.min(pollDelay * 2, POLL_MAX_MS);
      schedulePoll();
    }
  }, pollDelay);
}

function stopPoll(): void {
  if (pollTimer) clearTimeout(pollTimer);
  pollTimer = null;
}

async function loadTasks(): Promise<void> {
  tasks.value = await fetchUpdateTasks(10);
}

onMounted(async () => {
  try {
    await Promise.all([loadStatus(), loadTasks()]);
  } catch {
    MessagePlugin.error('加载系统更新状态失败');
  }
});

onBeforeUnmount(stopPoll);

// ---- 操作 ----
async function onCheck(): Promise<void> {
  checking.value = true;
  try {
    await checkUpdate();
    await Promise.all([loadStatus(), loadTasks()]);
    MessagePlugin.success(status.value?.status === 'update_available' ? '发现新版本' : '检查完成');
  } catch {
    MessagePlugin.error('检查更新失败，请稍后重试');
  } finally {
    checking.value = false;
  }
}

async function onInstall(): Promise<void> {
  if (!candidate.value) return;
  installing.value = true;
  try {
    const task = await installUpdate(candidate.value.releaseId);
    confirmOpen.value = false;
    MessagePlugin.success('安装任务已创建，开始执行更新');
    activeTaskId = task.taskId;
    pollDelay = POLL_BASE_MS;
    await Promise.all([loadStatus(), loadTasks()]);
  } catch {
    MessagePlugin.error('创建安装任务失败（候选可能已过期，请重新检查更新）');
  } finally {
    installing.value = false;
  }
}

async function onCancel(): Promise<void> {
  if (!activeTask.value) return;
  cancelling.value = true;
  try {
    await cancelUpdateTask(activeTask.value.taskId);
    MessagePlugin.success('更新任务已取消');
    await Promise.all([loadStatus(), loadTasks()]);
  } catch {
    MessagePlugin.error('取消失败：任务可能已进入不可取消阶段');
  } finally {
    cancelling.value = false;
  }
}

function confirmCancelTask(): void {
  void onCancel();
}

// ---- 展示辅助 ----
function isCancellable(statusName: UpdateTaskStatus): boolean {
  return statusName === 'queued' || statusName === 'downloading';
}

function stageLabel(statusName: UpdateTaskStatus): string {
  return UPDATE_STAGE_LABELS[statusName] ?? statusName;
}

function taskTagTheme(statusName: UpdateTaskStatus): string {
  if (statusName === 'succeeded') return 'success';
  if (statusName === 'rollback_failed') return 'danger';
  if (statusName === 'rolled_back' || statusName === 'cancelled') return 'warning';
  return 'primary';
}

function failureText(reason: string | null): string {
  if (!reason) return '未知原因';
  return UPDATE_FAILURE_REASON_TEXT[reason] ?? `更新源异常（${reason}）`;
}

function formatTime(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleString();
}

function formatSize(bytes: number): string {
  if (bytes >= 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GiB`;
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MiB`;
  return `${(bytes / 1024).toFixed(0)} KiB`;
}

const taskColumns = [
  { colKey: 'targetVersion', title: '目标版本', width: 110 },
  { colKey: 'status', title: '状态', width: 130 },
  { colKey: 'startedAt', title: '开始时间', width: 170 },
  { colKey: 'errorSummary', title: '备注', ellipsis: true },
];
</script>

<style scoped>
.system-update { max-width: 960px; }

.header-tag { margin-left: 8px; vertical-align: middle; }

.version-cards {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: var(--space-3, 16px);
  margin-bottom: 16px;
}

.version-card {
  background: var(--color-bg-surface);
  border: 1px solid var(--border-default);
  border-radius: var(--radius-md);
  padding: 16px;
  transition: border-color 0.2s ease, box-shadow 0.2s ease;
}
.version-card:hover {
  border-color: var(--border-strong);
  box-shadow: var(--shadow-glow), var(--shadow-sm);
}
.version-card h3 {
  font-size: 11px; font-weight: 600; letter-spacing: 0.08em;
  text-transform: uppercase; color: var(--text-tertiary); margin-bottom: 8px;
}
.version-card .value {
  font-family: var(--font-mono);
  font-size: 22px; font-weight: 600; letter-spacing: -0.02em;
  color: var(--text-primary);
}
.version-card .value.small { font-size: 15px; }
.version-card .hint { margin-top: 4px; font-size: 12px; color: var(--text-secondary); }

.glass-card {
  background: var(--color-bg-surface);
  border: 1px solid var(--border-default);
  border-radius: var(--radius-md);
  padding: 20px;
  margin-bottom: 16px;
  transition: border-color 0.2s ease, box-shadow 0.2s ease;
}
.glass-card:hover {
  border-color: var(--border-strong);
  box-shadow: var(--shadow-glow), var(--shadow-sm);
}
.glass-card h2 {
  font-family: var(--font-display);
  font-size: 15px; font-weight: 600; color: var(--text-primary);
}

.card-title-row { display: flex; align-items: center; gap: 10px; margin-bottom: 14px; }
.card-title-row h2 { flex: 0 0 auto; }
.card-title-row t-button { margin-left: auto; }

.stage-steps { display: flex; flex-wrap: wrap; gap: 4px 14px; margin-bottom: 12px; }
.stage-step { display: inline-flex; align-items: center; gap: 6px; font-size: 12px; color: var(--text-tertiary); }
.stage-dot {
  width: 8px; height: 8px; border-radius: 50%;
  background: var(--border-strong); flex: 0 0 auto;
}
.stage-step.done { color: var(--text-secondary); }
.stage-step.done .stage-dot { background: var(--color-accent); }
.stage-step.current { color: var(--text-primary); font-weight: 600; }
.stage-step.current .stage-dot {
  background: var(--color-accent);
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--color-accent) 20%, transparent);
}
.stage-step.failed { color: var(--color-danger); }
.stage-step.failed .stage-dot { background: var(--color-danger); }

.task-meta {
  display: flex; flex-wrap: wrap; gap: 4px 18px;
  margin-top: 10px; font-size: 12px; color: var(--text-secondary);
}
.task-meta .mono, .mono { font-family: var(--font-mono); }
.task-meta .error-text { color: var(--color-danger); }

.stale-banner { margin-bottom: 16px; }

.candidate-meta {
  display: grid; grid-template-columns: repeat(2, 1fr);
  gap: 8px 24px; margin-bottom: 12px;
}
.candidate-meta > div { display: flex; gap: 10px; font-size: 13px; }
.candidate-meta label { color: var(--text-tertiary); flex: 0 0 72px; }
.candidate-meta span { color: var(--text-primary); word-break: break-all; }

.release-notes { margin-bottom: 12px; }
.release-notes summary {
  cursor: pointer; font-size: 13px; font-weight: 500;
  color: var(--text-accent); user-select: none;
}
.notes-body {
  margin: 10px 0 0; padding: 12px;
  background: var(--color-bg-elevated);
  border: 1px solid var(--border-default);
  border-radius: var(--radius-sm);
  font-family: var(--font-mono); font-size: 12px; line-height: 1.7;
  white-space: pre-wrap; word-break: break-word;
  color: var(--text-secondary);
  max-height: 260px; overflow: auto;
}

.action-row { display: flex; gap: 12px; align-items: center; }
.action-row.standalone { justify-content: flex-start; }

.history-card .empty-hint { font-size: 13px; color: var(--text-tertiary); padding: 8px 0; }

.confirm-body p { margin-bottom: 10px; font-size: 14px; color: var(--text-primary); }
.confirm-body ul { margin: 0 0 10px 18px; }
.confirm-body li { font-size: 13px; color: var(--text-secondary); margin-bottom: 6px; }
.confirm-warn { color: var(--color-warning); font-size: 13px !important; }

@media (max-width: 720px) {
  .version-cards { grid-template-columns: 1fr; }
  .candidate-meta { grid-template-columns: 1fr; }
}
</style>
