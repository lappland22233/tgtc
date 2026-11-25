<template>
  <section class="ops-list" :aria-label="listTitle">
    <form class="ops-form" @submit.prevent="applyFilters">
      <label v-if="kind !== 'audit'">收件 Bot ID<input v-model.trim="draft.bot" inputmode="numeric" pattern="[0-9]+" autocomplete="off" /></label>
      <label v-if="!userId && kind !== 'audit'">TG 用户 ID<input v-model.trim="draft.user" inputmode="numeric" pattern="[0-9]+" autocomplete="off" /></label>
      <label v-if="kind !== 'audit'">状态<select v-model="draft.status">
        <option v-for="value in allowedStatuses" :key="value" :value="value">{{ labels[value] }}</option>
      </select></label>
      <label>开始时间<input v-model="draft.from" type="datetime-local" /></label>
      <label>结束时间<input v-model="draft.to" type="datetime-local" /></label>
      <div class="ops-actions">
        <button class="ops-btn primary" type="submit">筛选</button>
        <button class="ops-btn" type="button" @click="resetFilters">重置</button>
      </div>
    </form>
    <p v-if="filterError" role="alert" class="ops-error">{{ filterError }}</p>
    <div class="ops-list-head"><h2>{{ listTitle }}</h2><button class="ops-btn" type="button" @click="loadRows">刷新</button></div>
    <p v-if="notice" role="status">{{ notice }}</p>
    <p v-if="error" class="ops-error" role="alert">{{ error }}</p>
    <p v-if="loading" role="status">正在加载…</p>
    <p v-else-if="!error && !rows.length" class="ops-empty">没有符合条件的记录</p>
    <article v-for="row in rows" :key="row.id" class="ops-row">
      <template v-if="row.kind === 'audit'">
        <header><h3>{{ auditActions[row.action] || row.action }}</h3><span>{{ row.status }}</span></header>
        <dl class="ops-details">
          <div><dt>时间</dt><dd>{{ formatDateTime(row.createdAt, true) }}</dd></div>
          <div v-if="row.userId"><dt>操作用户</dt><dd>{{ row.userId }}</dd></div>
          <div v-if="row.resourceId"><dt>资源 ID</dt><dd>{{ row.resourceId }}</dd></div>
          <div v-for="field in auditFields(row.metadata)" :key="field.label"><dt>{{ field.label }}</dt><dd>{{ field.value }}</dd></div>
        </dl>
      </template>
      <template v-else>
        <header><h3>{{ row.fileName || '未命名文件' }}</h3><span class="ops-status" :class="{ muted: ['failed','cancelled','expired','revoked'].includes(row.status) }">{{ labels[row.status] }}</span></header>
        <dl class="ops-details">
          <div><dt>TG 用户</dt><dd><router-link v-if="!userId" :to="{ path:'/admin/bot-operations', query:{ tab:'user', telegramUserId:row.telegramUserId } }">{{ row.telegramUserId }}</router-link><template v-else>{{ row.telegramUserId }}</template><span v-if="row.telegramUsername || row.telegramDisplayName"> · {{ row.telegramUsername ? '@' + row.telegramUsername.replace(/^@/, '') : row.telegramDisplayName }}</span></dd></div>
          <div><dt>收件 Bot</dt><dd>{{ row.receiverBotId || '未记录' }}</dd></div>
          <div><dt>文件大小</dt><dd>{{ row.fileSize === null ? '未记录' : formatSize(row.fileSize) }}</dd></div>
          <div><dt>{{ row.kind === 'queue' ? '接收时间' : '签发时间' }}</dt><dd>{{ formatDateTime(row.createdAt, true) }}</dd></div>
          <template v-if="row.kind === 'queue'">
            <div v-if="row.position !== null"><dt>该 Bot 队列顺位</dt><dd>{{ row.position }}</dd></div>
            <div><dt>最后更新时间</dt><dd>{{ formatDateTime(row.updatedAt, true) }}</dd></div>
            <div v-if="row.startedAt"><dt>开始时间</dt><dd>{{ formatDateTime(row.startedAt, true) }}</dd></div>
            <div v-if="row.finishedAt"><dt>结束时间</dt><dd>{{ formatDateTime(row.finishedAt, true) }}</dd></div>
            <div v-if="row.failureReason"><dt>失败原因</dt><dd>{{ row.failureReason }}</dd></div>
            <div><dt>任务 ID</dt><dd>{{ row.id }}</dd></div>
            <div v-if="row.grantId"><dt>直链记录 ID</dt><dd>{{ row.grantId }}</dd></div>
          </template>
          <template v-else>
            <div><dt>存储后端</dt><dd>{{ row.storageBackend }}</dd></div>
            <div v-if="row.sourceAccountId"><dt>来源账号</dt><dd>{{ row.sourceAccountId }}</dd></div>
            <div><dt>剩余有效期</dt><dd>{{ remainingTime(row) }}</dd></div>
            <div><dt>到期时间</dt><dd>{{ formatDateTime(row.expiresAt, true) }}</dd></div>
            <div><dt>下载次数</dt><dd>{{ row.accessCount }}</dd></div>
            <div><dt>直链前缀</dt><dd>{{ row.tokenPrefix }}</dd></div>
            <div><dt>直链记录 ID</dt><dd>{{ row.id }}</dd></div>
            <div v-if="row.revokedAt"><dt>撤销时间</dt><dd>{{ formatDateTime(row.revokedAt, true) }}</dd></div>
          </template>
        </dl>
        <div v-if="row.kind === 'queue' && (row.status === 'queued' || row.status === 'running')" class="ops-actions">
          <button class="ops-btn danger" type="button" :disabled="changing" @click="pending = row.id">取消任务</button>
        </div>
        <div v-if="row.kind === 'grants' && row.status === 'active'" class="ops-actions">
          <button class="ops-btn" type="button" :disabled="replaying === row.id" @click="replay(row.id)">查看直链</button>
          <button class="ops-btn danger" type="button" :disabled="changing" @click="pending = row.id">撤销直链</button>
        </div>
        <div v-if="revealed?.id === row.id" class="ops-form">
          <label>有效直链<input :value="revealed.url" readonly @focus="($event.target as HTMLInputElement).select()" /></label>
          <button class="ops-btn" type="button" @click="revealed = null">收起</button>
        </div>
        <div v-if="pending === row.id" class="ops-confirm" role="group" aria-label="确认操作">
          <p>{{ row.kind === 'queue' ? '确定取消此收件任务？' : '确定撤销此直链？原链接将停止提供下载。' }}</p>
          <div class="ops-actions">
            <button class="ops-btn danger" type="button" :disabled="changing" @click="confirmChange(row.kind, row.id)">{{ row.kind === 'queue' ? '确认取消任务' : '确认撤销直链' }}</button>
            <button class="ops-btn" type="button" :disabled="changing" @click="pending = ''">返回</button>
          </div>
        </div>
      </template>
    </article>
    <nav v-if="!loading && !error && total > 0" class="ops-pages" aria-label="记录分页">
      <span>共 {{ total }} 条，第 {{ page }} / {{ pages }} 页</span>
      <div class="ops-actions">
        <button class="ops-btn" type="button" :disabled="page <= 1" @click="goTo(page - 1)">上一页</button>
        <button class="ops-btn" type="button" :disabled="page >= pages" @click="goTo(page + 1)">下一页</button>
      </div>
    </nav>
  </section>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, reactive, ref } from 'vue';
import { cancelTask, getGrantLink, listGrants, listQueue, listUserAudit, revokeGrant } from '@/api/bot-operations';
import type { AuditRow, BotListKind, GrantRow, GrantStatus, ListParams, QueueRow, QueueStatus } from '@/api/bot-operations';
import { formatDateTime, formatSize } from '@/utils/format';
import { getErrorMessage } from '@/utils/error';

type Row = (QueueRow & { kind:'queue' }) | (GrantRow & { kind:'grants' }) | (AuditRow & { kind:'audit' });
type Status = QueueStatus | GrantStatus | 'all';
const props = defineProps<{ kind: BotListKind; userId?: string }>();
const emit = defineEmits<{ changed: [] }>();
const labels: Record<Status,string> = { all:'全部', queued:'待处理', running:'处理中', completed:'已完成', failed:'失败', cancelled:'已取消', active:'有效', expired:'已到期', revoked:'已撤销' };
const queueStatuses: Status[] = ['all','queued','running','completed','failed','cancelled'];
const grantStatuses: Status[] = ['all','active','expired','revoked'];
const auditActions: Record<string,string> = {
  telegram_bot_task_cancelled:'取消任务', telegram_bot_link_revoked:'撤销直链', telegram_bot_user_banned:'封禁 TG 用户', telegram_bot_link_queried:'查看直链',
};
const detailLabels: Record<string, string> = {
  targetTelegramUserId: '目标 TG 用户', receiverBotId: '收件 Bot', taskId: '任务 ID', grantId: '直链记录 ID',
  reason: '原因', cancelledTasks: '取消任务数', revokedGrants: '撤销直链数', alreadyBanned: '此前已封禁',
  replayable: '可恢复完整直链', operatorTelegramUserId: 'TG 操作者', tokenPrefix: '直链前缀',
};
function auditFields(metadata: AuditRow['metadata']) {
  return Object.entries(detailLabels).filter(([key]) => metadata?.[key] != null).map(([key,label]) => ({ label, value: typeof metadata![key] === 'boolean' ? (metadata![key] ? '是' : '否') : String(metadata![key]) }));
}
const listTitle = computed(() => props.kind === 'queue' ? (props.userId ? '上传历史' : '收件任务') : props.kind === 'grants' ? '直链记录' : '操作审计');
const allowedStatuses = computed(() => props.kind === 'queue' ? queueStatuses : grantStatuses);
const defaultStatus = (): Status => props.kind === 'grants' && !props.userId ? 'active' : 'all';
const initialDraft = () => ({ bot:'', user:'', status:defaultStatus(), from:'', to:'' });
const draft = reactive(initialDraft());
const pageSize = 20;
const page = ref(1);
const total = ref(0);
const pages = computed(() => Math.max(1, Math.ceil(total.value / pageSize)));
const filters = ref<Omit<ListParams,'page'|'pageSize'>>(props.kind === 'audit' ? {} : { status:defaultStatus(), telegramUserId:props.userId });
const filterError = ref('');
const rows = ref<Row[]>([]);
const loading = ref(false);
const error = ref('');
const notice = ref('');
const pending = ref('');
const changing = ref(false);
const replaying = ref('');
const revealed = ref<{ id:string; url:string } | null>(null);
const clock = ref(Date.now());
let clockTimer: ReturnType<typeof setInterval> | undefined;
function remainingTime(grant: GrantRow) {
  if (grant.status === 'revoked') return '已撤销';
  const delta = Date.parse(grant.expiresAt) - clock.value;
  if (!Number.isFinite(delta)) return '未记录';
  if (grant.status === 'expired' || delta <= 0) return '已到期';
  const minutes = Math.ceil(delta / 60_000);
  if (minutes < 60) return minutes + ' 分钟';
  if (minutes < 1440) return Math.floor(minutes / 60) + ' 小时 ' + (minutes % 60) + ' 分钟';
  return Math.floor(minutes / 1440) + ' 天 ' + Math.floor(minutes % 1440 / 60) + ' 小时';
}
let listRequest: AbortController | undefined;
let linkRequest: AbortController | undefined;
let disposed = false;

function applyFilters() {
  filterError.value = '';
  if ([draft.bot, draft.user].some(value => value && !/^\d+$/.test(value))) {
    filterError.value = '收件 Bot ID 和 TG 用户 ID 只能包含数字。';
    return;
  }
  const from = draft.from ? new Date(draft.from) : null;
  const to = draft.to ? new Date(draft.to) : null;
  if ((from && !Number.isFinite(from.getTime())) || (to && !Number.isFinite(to.getTime())) || (from && to && from > to)) {
    filterError.value = '请填写有效时间，并确保结束时间不早于开始时间。';
    return;
  }
  filters.value = { from:from?.toISOString(), to:to?.toISOString() };
  if (props.kind !== 'audit') Object.assign(filters.value, { status:draft.status, receiverBotId:draft.bot || undefined, telegramUserId:props.userId || draft.user || undefined });
  notice.value = '';
  goTo(1);
}
function resetFilters() { Object.assign(draft, initialDraft()); applyFilters(); }
function goTo(next: number) { page.value = next; void loadRows(); }

async function loadRows() {
  listRequest?.abort();
  linkRequest?.abort();
  replaying.value = '';
  revealed.value = null;
  pending.value = '';
  const request = new AbortController();
  listRequest = request;
  loading.value = true;
  error.value = '';
  rows.value = [];
  const params = { ...filters.value, page:page.value, pageSize };
  try {
    let nextRows: Row[];
    let count: number;
    if (props.kind === 'queue') {
      const result = await listQueue(params, request.signal);
      nextRows = result.rows.map(row => ({...row, kind:'queue'}));
      count = result.total;
    } else if (props.kind === 'grants') {
      const result = await listGrants(params, request.signal);
      nextRows = result.rows.map(row => ({...row, kind:'grants'}));
      count = result.total;
    } else {
      const result = await listUserAudit(props.userId!, params, request.signal);
      nextRows = result.rows.map(row => ({...row, kind:'audit'}));
      count = result.total;
    }
    if (request.signal.aborted) return;
    total.value = count;
    if (page.value > pages.value) { goTo(pages.value); return; }
    rows.value = nextRows;
  } catch (err) {
    if (!request.signal.aborted) error.value = getErrorMessage(err);
  } finally {
    if (!request.signal.aborted) loading.value = false;
  }
}
async function replay(id: string) {
  linkRequest?.abort();
  const request = new AbortController();
  linkRequest = request;
  revealed.value = null;
  replaying.value = id;
  notice.value = '';
  try {
    const result = await getGrantLink(id, request.signal);
    if (request.signal.aborted) return;
    if (result.url) revealed.value = { id, url:result.url };
    else notice.value = '当前无法恢复完整直链。';
  } catch (err) {
    if (!request.signal.aborted) notice.value = getErrorMessage(err);
  } finally {
    if (!request.signal.aborted) replaying.value = '';
  }
}
async function confirmChange(kind: 'queue' | 'grants', id: string) {
  if (changing.value || pending.value !== id) return;
  changing.value = true;
  notice.value = '';
  try {
    const result = kind === 'queue' ? await cancelTask(id) : await revokeGrant(id);
    if (disposed) return;
    notice.value = result.changed ? (kind === 'queue' ? '任务已取消。' : '直链已撤销。') : '记录状态已变更。';
    emit('changed');
    await loadRows();
  } catch (err) {
    if (!disposed) notice.value = getErrorMessage(err);
  } finally { changing.value = false; }
}
onMounted(() => {
  if (props.kind === 'grants') clockTimer = setInterval(() => { clock.value = Date.now(); }, 60_000);
  void loadRows();
});
onBeforeUnmount(() => {
  disposed = true;
  clearInterval(clockTimer);
  listRequest?.abort();
  linkRequest?.abort();
});
</script>
