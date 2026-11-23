<template>
  <nav v-if="groups.length" class="workspace-admin-rail" aria-label="管理后台">
    <div class="admin-rail-links">
      <span class="admin-rail-title">管理后台</span>
      <div v-for="group in groups" :key="group.label" class="admin-rail-group">
        <span v-if="group.label !== '概览'" class="admin-rail-label">{{ group.label }}</span>
        <router-link v-for="link in group.links" :key="link.to" :to="link.to" class="admin-rail-link">
          {{ link.label }}
        </router-link>
      </div>
    </div>
    <label class="admin-rail-select">
      <span>管理后台</span>
      <select :value="route.path" @change="navigate">
        <optgroup v-for="group in groups" :key="group.label" :label="group.label">
          <option v-for="link in group.links" :key="link.to" :value="link.to">{{ link.label }}</option>
        </optgroup>
      </select>
    </label>
  </nav>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import type { UserRole } from '@/types/user';
import { getAdminNavGroups } from '@/utils/admin-navigation';

const props = defineProps<{ role: UserRole }>();
const route = useRoute();
const router = useRouter();
const groups = computed(() => getAdminNavGroups(props.role));

function navigate(event: Event) {
  const select = event.currentTarget as HTMLSelectElement;
  const to = select.value;
  if (groups.value.some(({ links }) => links.some((link) => link.to === to))) {
    void router.push(to);
  }
}
</script>

<style>
.workspace-admin-rail {
  min-width: 0;
  padding: 10px 16px;
  border-bottom: 1px solid var(--workspace-border);
  color: var(--workspace-text);
}

.admin-rail-links { display: none; }
.admin-rail-select { display: flex; align-items: center; justify-content: space-between; gap: 12px; font-size: 13px; font-weight: 600; }
.admin-rail-select select {
  min-width: 0;
  max-width: 65%;
  min-height: 44px;
  padding: 0 8px;
  border: 1px solid var(--workspace-border);
  border-radius: var(--radius-md);
  background: var(--workspace-surface);
  color: var(--workspace-text);
  font: inherit;
}

.workspace-admin-rail :is(a,select):focus-visible { outline: 2px solid var(--workspace-accent); outline-offset: 2px; }

@media (min-width: 960px) {
  .workspace-admin-rail {
    position: sticky;
    top: var(--workspace-header-height);
    align-self: start;
    max-height: calc(100dvh - var(--workspace-header-height));
    padding: 20px 12px;
    border: 0;
    overflow: auto;
  }

  .admin-rail-select { display: none; }
  .admin-rail-links { display: grid; gap: 13px; }
  .admin-rail-title { padding-inline: 9px; font-size: 14px; font-weight: 650; }
  .admin-rail-group { display: grid; gap: 2px; }
  .admin-rail-label { padding: 0 9px 3px; font-size: 12px; color: var(--workspace-muted); }
  .admin-rail-link {
    display: flex;
    align-items: center;
    min-height: 37px;
    padding: 5px 9px;
    border-radius: var(--radius-md);
    color: var(--workspace-text);
    font-size: 13px;
    text-decoration: none;
  }

  .admin-rail-link:is(:hover, [aria-current='page']) {
    background: var(--workspace-selected);
    color: var(--workspace-accent);
  }
  .admin-rail-link[aria-current='page'] { font-weight: 650; }
}
</style>
