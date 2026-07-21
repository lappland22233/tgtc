<template>
  <div
    v-if="unacknowledgedCount > 0"
    style="cursor: pointer"
    aria-live="polite"
    role="alert"
    @click="router.push('/admin/security')"
  >
    <t-alert :theme="unacknowledgedCount > 5 ? 'error' : 'warning'" :message="`⚠ 有 ${unacknowledgedCount} 条未确认告警，点击查看`" />
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted, onUnmounted } from 'vue';
import { useRouter } from 'vue-router';
import { api } from '@/stores/auth';

const router = useRouter();
const unacknowledgedCount = ref(0);
let timer: ReturnType<typeof setInterval> | null = null;
let controller: AbortController | null = null;

function stopPolling() {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}

async function fetchAlerts() {
  // 标签页不可见时跳过轮询，避免后台无意义请求
  if (typeof document !== 'undefined' && document.hidden) return;

  // 取消上一次尚未完成的请求，防止慢响应堆积/竞态覆盖
  controller?.abort();
  controller = new AbortController();
  try {
    const res = await api.get('/admin/alerts/unacknowledged', { signal: controller.signal });
    unacknowledgedCount.value = Array.isArray(res.data?.data) ? res.data.data.length : 0;
  } catch (err: any) {
    // 主动取消的请求直接忽略
    if (err?.name === 'AbortError' || err?.code === 'ERR_CANCELED') return;
    const status = err?.response?.status;
    if (status === 401 || status === 403) {
      // 会话失效/无权限：停止轮询，避免告警数永久停留旧值且持续无效请求
      stopPolling();
    }
    // 其他瞬时错误保留上次计数，下个周期自动重试
  }
}

onMounted(() => {
  fetchAlerts();
  timer = setInterval(fetchAlerts, 30000);
});

onUnmounted(() => {
  stopPolling();
  controller?.abort();
  controller = null;
});
</script>
