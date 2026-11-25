<template>
  <section class="ops-user">
    <header class="ops-list-head"><h2>TG 用户 {{ userId }}</h2><button class="ops-btn" type="button" @click="refresh">刷新用户</button></header>
    <p v-if="error" role="alert" class="ops-error">{{ error }}</p>
    <p v-else-if="!overview" role="status">正在加载…</p>
    <template v-if="overview">
      <dl class="ops-summary">
        <div><dt>上传任务</dt><dd>{{ overview.uploads.total }}</dd></div>
        <div><dt>待处理 / 处理中</dt><dd>{{ overview.uploads.byStatus.queued }} / {{ overview.uploads.byStatus.running }}</dd></div>
        <div><dt>已完成 / 失败 / 已取消</dt><dd>{{ overview.uploads.byStatus.completed }} / {{ overview.uploads.byStatus.failed }} / {{ overview.uploads.byStatus.cancelled }}</dd></div>
        <div><dt>有效 / 全部直链</dt><dd>{{ overview.grants.active }} / {{ overview.grants.total }}</dd></div>
        <div><dt>下载请求 / 流量</dt><dd>{{ overview.downloads.requests }} / {{ formatSize(overview.downloads.bytes) }}</dd></div>
        <div><dt>{{ overview.quota.usageDate }} 已用配额</dt><dd>{{ overview.quota.used }} / {{ overview.quota.limit ?? '不限' }}</dd></div>
        <div><dt>当日剩余</dt><dd>{{ overview.quota.remaining ?? '不限' }}{{ overview.quota.whitelisted ? '（白名单）' : '' }}</dd></div>
      </dl>
      <div v-if="overview.ban" class="ops-confirm">
        <strong>已封禁</strong><p>{{ overview.ban.reason }}</p>
        <p>{{ formatDateTime(overview.ban.bannedAt, true) }}<span v-if="overview.ban.bannedBy"> · 操作用户 {{ overview.ban.bannedBy }}</span></p>
      </div>
      <template v-else>
        <button v-if="!showBan" class="ops-btn danger" type="button" @click="showBan = true">封禁 TG 用户</button>
        <form v-else class="ops-confirm" @submit.prevent="confirmBan">
          <label>封禁原因<textarea v-model.trim="reason" required maxlength="500" rows="2" /></label>
          <p>封禁用户 {{ userId }} 将取消其未完成的收件任务并撤销有效直链。</p>
          <div class="ops-actions">
            <button class="ops-btn danger" type="submit" :disabled="saving || !reason.trim()">确认封禁</button>
            <button class="ops-btn" type="button" :disabled="saving" @click="showBan = false; reason = ''">返回</button>
          </div>
        </form>
      </template>
      <p v-if="notice" role="status">{{ notice }}</p>
    </template>
    <nav class="ops-tabs" aria-label="用户历史分类">
      <button v-for="option in historyTabs" :key="option.kind" type="button" :aria-pressed="kind === option.kind" @click="kind = option.kind">{{ option.label }}</button>
    </nav>
    <BotOperationsList :key="kind + revision" :kind="kind" :user-id="userId" @changed="loadUser" />
  </section>
</template>

<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue';
import { banBotUser, getBotUser, type BotListKind, type BotUserOverview } from '@/api/bot-operations';
import { formatDateTime, formatSize } from '@/utils/format';
import { getErrorMessage } from '@/utils/error';
import BotOperationsList from './BotOperationsList.vue';

const props = defineProps<{ userId: string; initialKind?: BotListKind }>();
const historyTabs = [{ kind:'queue', label:'上传历史' },{ kind:'grants', label:'直链历史' },{ kind:'audit', label:'操作审计' }] as const;
const kind = ref<BotListKind>(props.initialKind ?? 'queue');
const revision = ref(0);
const overview = ref<BotUserOverview | null>(null);
const error = ref('');
const notice = ref('');
const reason = ref('');
const showBan = ref(false);
const saving = ref(false);
let currentRequest: AbortController | undefined;
let disposed = false;
async function loadUser() {
  currentRequest?.abort();
  const request = new AbortController();
  currentRequest = request;
  error.value = '';
  try {
    const result = await getBotUser(props.userId, request.signal);
    if (!request.signal.aborted) overview.value = result;
  } catch (err) {
    if (!request.signal.aborted) { overview.value = null; error.value = getErrorMessage(err); }
  }
}
function refresh() { revision.value++; void loadUser(); }
async function confirmBan() {
  if (saving.value || !showBan.value || !reason.value.trim() || overview.value?.ban) return;
  saving.value = true;
  notice.value = '';
  try {
    const result = await banBotUser(props.userId, reason.value.trim());
    if (disposed) return;
    notice.value = `已封禁该用户，取消 ${result.cancelledTasks} 项任务并撤销 ${result.revokedGrants} 条直链。`;
    showBan.value = false;
    reason.value = '';
    refresh();
  } catch (err) {
    if (!disposed) notice.value = getErrorMessage(err);
  } finally { saving.value = false; }
}
onMounted(loadUser);
onBeforeUnmount(() => { disposed = true; currentRequest?.abort(); });
</script>
