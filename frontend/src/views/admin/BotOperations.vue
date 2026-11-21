<template>
  <div class="bot-operations">
    <header class="page-header"><h1>Bot 收件管理</h1></header>
    <nav class="ops-tabs" aria-label="Bot 管理分区">
      <router-link v-for="item in tabs" :key="item.key" :to="{ path: '/admin/bot-operations', query: { tab: item.key } }"
        :aria-current="tab === item.key ? 'page' : undefined">{{ item.label }}</router-link>
    </nav>
    <template v-if="tab === 'user'">
      <form class="ops-form" @submit.prevent="openUser">
        <label>TG 用户 ID<input v-model.trim="userInput" type="text" inputmode="numeric" pattern="[0-9]+" required autocomplete="off" /></label>
        <button class="ops-btn primary" type="submit">查看用户</button>
      </form>
      <BotOperationsUser v-if="userId" :key="userId" :user-id="userId" />
    </template>
    <BotOperationsList v-else :key="tab" :kind="tab" />
  </div>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import BotOperationsList from './BotOperationsList.vue';
import BotOperationsUser from './BotOperationsUser.vue';

const tabs = [{ key: 'queue', label: '收件队列' }, { key: 'grants', label: '直链管理' }, { key: 'user', label: '用户审计' }] as const;
const route = useRoute();
const router = useRouter();
const tab = computed(() => route.query.tab === 'user' ? 'user' : route.query.tab === 'grants' ? 'grants' : 'queue');
const userId = computed(() => typeof route.query.telegramUserId === 'string' && /^\d+$/.test(route.query.telegramUserId) ? route.query.telegramUserId : '');
const userInput = ref('');
watch(userId, id => { userInput.value = id; }, { immediate: true });
function openUser() {
  if (/^\d+$/.test(userInput.value)) void router.push({ path: '/admin/bot-operations', query: { tab: 'user', telegramUserId: userInput.value } });
}
</script>

<style src="./bot-operations.css"></style>
