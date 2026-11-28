<template>
  <div class="telegram-accounts-page">
    <div class="page-header">
      <h1>Telegram 账号池</h1>
      <p>统一管理 Bot / 用户账号、镜像备份规则与任务队列（仅超级管理员可见）</p>
    </div>

    <nav class="tg-outline" aria-label="账号池分区导航">
      <a href="#tg-overview" class="tg-outline-link">状态总览</a>
      <a href="#tg-replication" class="tg-outline-link">副本扩散策略</a>
      <a href="#tg-accounts" class="tg-outline-link">账号管理</a>
      <a href="#tg-mirror" class="tg-outline-link">镜像规则</a>
      <a href="#tg-backfill" class="tg-outline-link">历史补偿</a>
      <a href="#tg-tasks" class="tg-outline-link">镜像任务</a>
    </nav>

    <TelegramOverviewSection
      :overview="overview"
      :mirror="mirror"
      :feature-saving="featureSaving"
      @toggle-pool="toggleAccountPool"
      @toggle-mirror="toggleMirror"
    />

    <TelegramReplicationSection
      :user-copy-count="mirror?.metrics.userCopyCount ?? 0"
    />

    <TelegramAccountsSection
      :overview="overview"
      @refresh-overview="loadOverview"
    />

    <TelegramMirrorSection
      :mirror="mirror"
      @refresh-mirror="loadMirror"
    />

    <div class="audit-entry">
      <router-link to="/admin/audit-logs">前往操作审计查看相关记录</router-link>
    </div>
  </div>
</template>

<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { DialogPlugin } from 'tdesign-vue-next/es/dialog';
import MessagePlugin from '@/utils/message';
import { getErrorMessage } from '@/utils/error';
import {
  fetchAccountOverview,
  fetchMirrorOverview,
  setAccountPoolEnabled,
  setMirrorEnabled,
  type AccountPoolOverview,
  type MirrorOverview,
} from '@/api/telegram-accounts';
import TelegramOverviewSection from '@/components/admin/telegram/TelegramOverviewSection.vue';
import TelegramReplicationSection from '@/components/admin/telegram/TelegramReplicationSection.vue';
import TelegramAccountsSection from '@/components/admin/telegram/TelegramAccountsSection.vue';
import TelegramMirrorSection from '@/components/admin/telegram/TelegramMirrorSection.vue';

const overview = ref<AccountPoolOverview | null>(null);
const mirror = ref<MirrorOverview | null>(null);
const featureSaving = ref(false);

async function loadOverview() {
  try {
    overview.value = await fetchAccountOverview();
  } catch {
    MessagePlugin.error('账号池总览加载失败，已保留上次数据');
  }
}

async function loadMirror() {
  try {
    mirror.value = await fetchMirrorOverview();
  } catch {
    MessagePlugin.error('镜像规则加载失败，已保留上次数据');
  }
}

async function toggleAccountPool(enabled: boolean) {
  if ((overview.value?.feature.accountPoolEnabled ?? false) === enabled) return;
  const dialog = DialogPlugin.confirm({
    header: enabled ? '开启账号池' : '关闭账号池',
    body: enabled
      ? '开启后新任务将使用账号池调度。'
      : '关闭只阻止新镜像任务，不删除已备份文件；在途传输会正常收尾。',
    onConfirm: async () => {
      dialog.destroy();
      featureSaving.value = true;
      try {
        const result = await setAccountPoolEnabled(enabled);
        MessagePlugin.success(result.message);
        await loadOverview();
      } catch (error) {
        MessagePlugin.error(getErrorMessage(error));
      } finally {
        featureSaving.value = false;
      }
    },
    onClose: () => dialog.destroy(),
  });
}

async function toggleMirror(enabled: boolean) {
  if ((mirror.value?.feature.mirrorEnabled ?? false) === enabled) return;
  const dialog = DialogPlugin.confirm({
    header: enabled ? '开启镜像功能' : '关闭镜像功能',
    body: enabled
      ? '开启后新文件将按规则镜像到备份群。'
      : '关闭只阻止新任务，已开始的镜像会正常收尾，也不删除已备份内容。',
    onConfirm: async () => {
      dialog.destroy();
      featureSaving.value = true;
      try {
        const result = await setMirrorEnabled(enabled);
        MessagePlugin.success(result.message);
        await loadOverview();
      } catch (error) {
        MessagePlugin.error(getErrorMessage(error));
      } finally {
        featureSaving.value = false;
      }
    },
    onClose: () => dialog.destroy(),
  });
}

onMounted(() => {
  void Promise.all([loadOverview(), loadMirror()]);
});
</script>

<style scoped>
.telegram-accounts-page {
  padding: 0;
}

.tg-outline {
  display: flex;
  flex-wrap: nowrap;
  gap: 6px;
  overflow-x: auto;
  scrollbar-width: thin;
  padding: 8px 10px;
  margin-bottom: 16px;
  background: var(--color-bg-surface);
  border: 1px solid var(--border-default);
  border-radius: var(--radius-md);
}

.tg-outline-link {
  flex: none;
  padding: 6px 10px;
  border-radius: var(--radius-sm);
  font-size: 13px;
  font-weight: 500;
  color: var(--text-secondary);
  text-decoration: none;
  white-space: nowrap;
  transition: background-color var(--duration-fast) var(--ease-out-expo), color var(--duration-fast) var(--ease-out-expo);
}

.tg-outline-link:hover {
  background: var(--color-bg-hover);
  color: var(--seed-primary);
}

.audit-entry {
  margin: var(--space-2) 0 var(--space-6);
  font-size: 13px;
}

.audit-entry a {
  color: var(--workspace-accent);
  text-decoration: none;
}

.audit-entry a:hover {
  text-decoration: underline;
}

@media (min-width: 769px) {
  .tg-outline {
    position: sticky;
    top: 12px;
    z-index: 5;
    flex-wrap: wrap;
  }
}
</style>
