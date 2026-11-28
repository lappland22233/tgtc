<template>
  <section class="card admin-chart-card">
    <div v-if="title || $slots.title || $slots.actions" class="admin-chart-head">
      <div class="admin-chart-heading">
        <slot name="title">
          <h3 class="card-title mb-0">{{ title }}</h3>
        </slot>
        <p v-if="subtitle" class="admin-chart-sub">{{ subtitle }}</p>
      </div>
      <div v-if="$slots.actions" class="section-actions">
        <slot name="actions" />
      </div>
    </div>
    <div class="admin-chart-body">
      <slot />
    </div>
  </section>
</template>

<script setup lang="ts">
defineProps<{
  title?: string;
  subtitle?: string;
}>();
</script>

<style scoped>
.admin-chart-head {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  justify-content: space-between;
  gap: 8px;
  margin-bottom: 12px;
}

.admin-chart-heading {
  min-width: 0;
}

.admin-chart-sub {
  margin: 4px 0 0;
  font-size: 12px;
  color: var(--text-secondary);
}

.admin-chart-body {
  min-width: 0;
}

@media (min-width: 769px) {
  .admin-chart-head {
    flex-direction: row;
    align-items: center;
  }
}
</style>
