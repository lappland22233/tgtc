<template>
  <component :is="link ? 'router-link' : 'span'" v-bind="link ? { to: link } : {}" class="workspace-brand">
    <span class="workspace-brand-mark" aria-hidden="true">
      <svg width="18" height="18" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
        <path d="M10 2L17 6v8l-7 4-7-4V6l7-4zM10 10l7-4m-7 4v8m0-8L3 6" />
      </svg>
    </span>
    <span class="workspace-brand-title" :title="config.siteTitle">{{ config.siteTitle }}</span>
  </component>
</template>

<script setup lang="ts">
import { usePublicConfigStore } from '@/stores/public-config';

defineProps<{ link?: string }>();
const config = usePublicConfigStore();
</script>

<style>
.workspace-brand {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
  color: var(--workspace-text);
  font-size: 16px;
  font-weight: 700;
  text-decoration: none;
}

.workspace-brand-title {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.workspace-brand-mark {
  display: grid;
  place-items: center;
  width: 32px;
  height: 32px;
  flex: none;
  border-radius: 9px;
  background: var(--workspace-accent);
  color: var(--workspace-on-accent);
}
</style>
