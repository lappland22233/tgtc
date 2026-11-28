<template>
  <div id="tg-overview">
    <!-- 能力状态条：三层开关 + 前置检查 -->
    <section class="card status-card" aria-label="能力状态">
      <div class="status-switches">
        <div class="status-switch">
          <div class="status-switch-text">
            <span class="status-switch-label">账号池总开关</span>
            <span class="status-switch-meta">
              {{ featureSourceText(overview?.feature.accountPoolSource) }}
              <template v-if="overview?.feature.accountPoolForceDisabled">· 已被环境变量强制关闭</template>
            </span>
          </div>
          <t-switch
            :value="overview?.feature.accountPoolEnabled ?? false"
            :disabled="overview?.feature.accountPoolForceDisabled ?? false"
            :loading="featureSaving"
            @change="(v: boolean) => emit('toggle-pool', Boolean(v))"
          />
        </div>

        <div class="status-switch">
          <div class="status-switch-text">
            <span class="status-switch-label">镜像功能总开关</span>
            <span class="status-switch-meta">
              {{ featureSourceText(overview?.feature.mirrorSource ?? mirror?.feature.source) }}
              <template v-if="overview?.feature.mirrorForceDisabled ?? mirror?.feature.forceDisabled">· 已被环境变量强制关闭</template>
            </span>
          </div>
          <t-switch
            :value="mirror?.feature.mirrorEnabled ?? false"
            :disabled="mirror?.feature.forceDisabled ?? false"
            :loading="featureSaving"
            @change="(v: boolean) => emit('toggle-mirror', Boolean(v))"
          />
        </div>
      </div>

      <div v-if="precheckFailures.length > 0" class="precheck-list">
        <t-alert theme="warning" title="前置检查未通过项">
          <ul class="precheck-items">
            <li v-for="item in precheckFailures" :key="item.id">{{ item.hint }}</li>
          </ul>
        </t-alert>
      </div>
    </section>

    <!-- 总览卡区 -->
    <section class="overview-grid" aria-label="总览">
      <div class="stat-card">
        <h3>账号总数</h3>
        <div class="value">{{ counts.total }}</div>
        <div class="stat-sub">Bot {{ counts.bot }} · 用户 {{ counts.user }}</div>
        <div class="stat-sub">
          正常 {{ counts.active }} · 降级 {{ counts.degraded }} · 停用 {{ counts.disabled }} · 撤销 {{ counts.revoked }} · 待授权 {{ counts.pendingAuth }}
        </div>
      </div>

      <div class="stat-card">
        <h3>镜像规则</h3>
        <div class="value">{{ enabledRuleCount }} / {{ mirrorRuleCount }}</div>
        <div class="stat-sub">启用 {{ enabledRuleCount }} 条 · 共 {{ mirrorRuleCount }} 条（每条启用规则一个镜像群）</div>
        <div class="stat-sub">当前主群：{{ mirror?.mainChatId || '未配置' }}</div>
      </div>

      <div class="stat-card">
        <h3>今日任务</h3>
        <div class="value">{{ tasks.todaySucceeded }}</div>
        <div class="stat-sub">成功 {{ tasks.todaySucceeded }} · 失败 {{ tasks.todayFailed }} · 阻塞 {{ tasks.todayBlocked }}</div>
        <div class="stat-sub">队列中 {{ tasks.queued }} · 执行中 {{ tasks.running }} · 重试中 {{ tasks.retrying }}</div>
      </div>

      <div class="stat-card">
        <h3>最近一次错误</h3>
        <div class="value error-value">{{ tasks.lastError?.code || '无' }}</div>
        <div class="stat-sub error-summary">{{ tasks.lastError?.summary || '暂无错误记录' }}</div>
        <div class="stat-sub">{{ formatTime(tasks.lastError?.at) }}</div>
      </div>
    </section>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import type { AccountPoolOverview, MirrorOverview, MirrorTaskSummary } from '@/api/telegram-accounts';
import { featureSourceText, formatTime } from '@/utils/telegram-format';

const props = defineProps<{
  overview: AccountPoolOverview | null;
  mirror: MirrorOverview | null;
  featureSaving: boolean;
}>();

const emit = defineEmits<{
  'toggle-pool': [enabled: boolean];
  'toggle-mirror': [enabled: boolean];
}>();

const counts = computed(() => props.overview?.counts ?? {
  total: 0,
  bot: 0,
  user: 0,
  enabled: 0,
  active: 0,
  degraded: 0,
  disabled: 0,
  revoked: 0,
  pendingAuth: 0,
});

const emptyTaskSummary: MirrorTaskSummary = {
  queued: 0,
  running: 0,
  succeeded: 0,
  retrying: 0,
  failed: 0,
  blocked: 0,
  cancelled: 0,
  todaySucceeded: 0,
  todayFailed: 0,
  todayBlocked: 0,
  lastError: null,
};

const tasks = computed<MirrorTaskSummary>(() => props.mirror?.tasks ?? emptyTaskSummary);

const precheckFailures = computed(() => {
  const items = [
    ...(props.overview?.precheck ?? []),
    ...(props.mirror?.precheck ?? []),
  ];
  const seen = new Set<string>();
  return items.filter((item) => {
    if (item.ok || seen.has(item.id)) return false;
    seen.add(item.id);
    return true;
  });
});

const mirrorRuleCount = computed(() => props.mirror?.rules.length ?? 0);
const enabledRuleCount = computed(() => props.mirror?.enabledRuleCount ?? 0);
</script>

<style scoped>
.status-card {
  padding: var(--space-4);
}

.status-switches {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(min(100%, 240px), 1fr));
  gap: var(--space-4);
}

.status-switch {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-3);
  padding: var(--space-3) var(--space-4);
  background: var(--color-bg-elevated);
  border: 1px solid var(--border-default);
  border-radius: var(--radius-md);
}

.status-switch-text {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}

.status-switch-label {
  font-size: 14px;
  font-weight: 600;
  color: var(--text-primary);
}

.status-switch-meta {
  font-size: 12px;
  color: var(--text-secondary);
}

.precheck-list {
  margin-top: var(--space-4);
}

.precheck-items {
  margin: 0;
  padding-left: var(--space-4);
  font-size: 13px;
  line-height: 1.6;
}

.overview-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(min(100%, 220px), 1fr));
  gap: var(--space-4);
  margin-bottom: var(--space-4);
}

.stat-card .stat-sub {
  font-size: 12px;
  color: var(--text-secondary);
  margin-top: 6px;
  line-height: 1.5;
}

.error-value {
  font-size: 18px;
}

.error-summary {
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}
</style>
