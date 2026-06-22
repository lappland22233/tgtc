<template>
  <div v-if="unacknowledgedCount > 0" style="cursor: pointer" @click="router.push('/admin/alerts')">
    <t-alert :theme="unacknowledgedCount > 5 ? 'error' : 'warning'" :message="`⚠️ 有 ${unacknowledgedCount} 条未确认告警，点击查看`" />
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted, onUnmounted } from 'vue';
import { useRouter } from 'vue-router';
import { api } from '@/stores/auth';

const router = useRouter();
const unacknowledgedCount = ref(0);
let timer: ReturnType<typeof setInterval> | null = null;

async function fetchAlerts() {
  try {
    const res = await api.get('/admin/alerts/unacknowledged');
    unacknowledgedCount.value = Array.isArray(res.data?.data) ? res.data.data.length : 0;
  } catch {
    /* ignore */
  }
}

onMounted(() => {
  fetchAlerts();
  timer = setInterval(fetchAlerts, 30000);
});

onUnmounted(() => {
  if (timer) clearInterval(timer);
});
</script>
