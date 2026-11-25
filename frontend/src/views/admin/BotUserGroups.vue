<template>
  <section class="ops-groups" :aria-label="title">
    <form class="ops-form" @submit.prevent="applyFilters">
      <label>搜索用户<input v-model.trim="draftKeyword" type="search" maxlength="64" :placeholder="searchPlaceholder" autocomplete="off" /></label>
      <label>时间范围<select v-model="draftRange">
        <option value="all">全部时间</option>
        <option value="24h">近 24 小时</option>
        <option value="7d">近 7 天</option>
        <option value="30d">近 30 天</option>
      </select></label>
      <div class="ops-actions">
        <button class="ops-btn primary" type="submit">查询</button>
        <button class="ops-btn" type="button" @click="resetFilters">重置</button>
      </div>
    </form>

    <div class="ops-list-head">
      <div class="ops-group-heading">
        <h2>{{ title }}</h2>
        <p class="ops-group-hint">{{ hint }}</p>
      </div>
      <button class="ops-btn" type="button" :disabled="loading" @click="loadRows">刷新</button>
    </div>

    <p v-if="error" role="alert" class="ops-error">{{ error }}</p>
    <p v-if="loading" role="status">正在加载用户…</p>
    <p v-else-if="!error && !rows.length" class="ops-empty">没有匹配的用户</p>

    <router-link v-for="row in rows" :key="row.telegramUserId" class="ops-group-row" :to="detailLink(row.telegramUserId)">
      <span class="ops-group-avatar" aria-hidden="true">{{ initial(row) }}</span>
      <div class="ops-group-main">
        <div class="ops-group-head">
          <strong class="ops-group-id">{{ row.telegramUserId }}</strong>
          <span v-if="row.telegramUsername" class="ops-group-name">@{{ row.telegramUsername.replace(/^@/, '') }}</span>
          <span v-else class="ops-group-name muted">未设置用户名</span>
        </div>
        <div v-if="chips(row).length" class="ops-group-chips">
          <span v-for="chip in chips(row)" :key="chip.label" class="ops-chip" :class="chip.tone">{{ chip.label }}</span>
        </div>
      </div>
      <div class="ops-group-side">
        <strong class="ops-group-metric">{{ metric(row) }}</strong>
        <span v-if="secondary(row)" class="ops-group-size">{{ secondary(row) }}</span>
        <span class="ops-group-time">最近活动 {{ formatDateTime(row.lastAt, true) }}</span>
        <span class="ops-group-cta">查看详情<span aria-hidden="true"> ›</span></span>
      </div>
    </router-link>

    <nav v-if="!loading && !error && total > 0" class="ops-pages" aria-label="用户列表分页">
      <span>共 {{ total }} 位用户，第 {{ page }} / {{ pages }} 页</span>
      <div class="ops-actions">
        <button class="ops-btn" type="button" :disabled="page <= 1" @click="goTo(page - 1)">上一页</button>
        <button class="ops-btn" type="button" :disabled="page >= pages" @click="goTo(page + 1)">下一页</button>
      </div>
    </nav>
  </section>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import { listUserGroups, type UserGroupRow, type UserGroupScope } from '@/api/bot-operations';
import { formatDateTime, formatSize } from '@/utils/format';
import { getErrorMessage } from '@/utils/error';

type Range = 'all' | '24h' | '7d' | '30d';
type Tone = '' | 'success' | 'danger' | 'warning' | 'accent';

const props = defineProps<{ scope: UserGroupScope; tabKey: 'queue' | 'grants' | 'user' }>();

const titles: Record<UserGroupScope, string> = { queue: '收件用户', grants: '直链用户', audit: '审计用户' };
const hints: Record<UserGroupScope, string> = {
  queue: '按 TG 用户聚合收件任务，点击用户查看任务明细与处置操作。',
  grants: '按 TG 用户聚合直链签发，点击用户查看直链历史与撤销操作。',
  audit: '按 TG 用户聚合管理员处置记录，点击用户查看完整审计轨迹。',
};
const title = computed(() => titles[props.scope]);
const hint = computed(() => hints[props.scope]);
const searchPlaceholder = computed(() => props.scope === 'audit' ? '搜索 TG 用户 ID' : '搜索 TG 用户 ID 或 @用户名');

const draftKeyword = ref('');
const keyword = ref('');
const draftRange = ref<Range>('all');
const range = ref<Range>('all');
const page = ref(1);
const pageSize = 20;
const total = ref(0);
const rows = ref<UserGroupRow[]>([]);
const loading = ref(false);
const error = ref('');
const pages = computed(() => Math.max(1, Math.ceil(total.value / pageSize)));
let request: AbortController | undefined;
let disposed = false;

function fromParam(): string | undefined {
  if (range.value === 'all') return undefined;
  const hours = range.value === '24h' ? 24 : range.value === '7d' ? 168 : 720;
  return new Date(Date.now() - hours * 3_600_000).toISOString();
}

async function loadRows() {
  request?.abort();
  const controller = new AbortController();
  request = controller;
  loading.value = true;
  error.value = '';
  rows.value = [];
  try {
    const result = await listUserGroups({
      scope: props.scope,
      page: page.value,
      pageSize,
      keyword: keyword.value || undefined,
      from: fromParam(),
    }, controller.signal);
    if (controller.signal.aborted || disposed) return;
    total.value = result.total;
    rows.value = Array.isArray(result.rows) ? result.rows : [];
    if (page.value > pages.value) { page.value = pages.value; void loadRows(); }
  } catch (err) {
    if (!controller.signal.aborted && !disposed) {
      total.value = 0;
      error.value = getErrorMessage(err);
    }
  } finally {
    if (!controller.signal.aborted && !disposed) loading.value = false;
  }
}

function applyFilters() {
  keyword.value = draftKeyword.value.trim();
  range.value = draftRange.value;
  page.value = 1;
  void loadRows();
}

function resetFilters() {
  draftKeyword.value = '';
  draftRange.value = 'all';
  applyFilters();
}

function goTo(next: number) {
  page.value = next;
  void loadRows();
}

function detailLink(telegramUserId: string) {
  return { path: '/admin/bot-operations', query: { tab: props.tabKey, telegramUserId } };
}

function initial(row: UserGroupRow) {
  const name = (row.telegramUsername ?? '').replace(/^@/, '') || row.telegramUserId;
  return name.slice(0, 1).toUpperCase();
}

function metric(row: UserGroupRow) {
  if (props.scope === 'grants') return `${formatNumber(row.total)} 条直链`;
  if (props.scope === 'audit') return `${formatNumber(row.total)} 次操作`;
  return `${formatNumber(row.total)} 个任务`;
}

function secondary(row: UserGroupRow) {
  if (props.scope === 'grants') return `累计下载 ${formatNumber(row.downloads)} 次`;
  if (props.scope === 'queue') return `数据量 ${formatSize(row.bytes)}`;
  return '';
}

function chips(row: UserGroupRow) {
  const definitions: { label: string; count: number; tone: Tone }[] = [];
  if (props.scope === 'queue') {
    definitions.push(
      { label: '待处理', count: row.byStatus.queued ?? 0, tone: 'warning' },
      { label: '处理中', count: row.byStatus.running ?? 0, tone: 'accent' },
      { label: '已完成', count: row.byStatus.completed ?? 0, tone: 'success' },
      { label: '失败', count: row.byStatus.failed ?? 0, tone: 'danger' },
      { label: '已取消', count: row.byStatus.cancelled ?? 0, tone: '' },
    );
  } else if (props.scope === 'grants') {
    definitions.push(
      { label: '有效', count: row.byStatus.active ?? 0, tone: 'success' },
      { label: '已到期', count: row.byStatus.expired ?? 0, tone: '' },
      { label: '已撤销', count: row.byStatus.revoked ?? 0, tone: 'danger' },
    );
  }
  return definitions
    .filter(chip => chip.count > 0)
    .map(chip => ({ label: `${chip.label} ${formatNumber(chip.count)}`, tone: chip.tone }));
}

function formatNumber(value: number): string {
  if (!Number.isFinite(value)) return '0';
  if (value >= 1_000_000) return (value / 1_000_000).toFixed(1) + 'M';
  if (value >= 1_000) return (value / 1_000).toFixed(1) + 'K';
  return String(value);
}

onMounted(loadRows);
onBeforeUnmount(() => {
  disposed = true;
  request?.abort();
});
</script>
