<template>
  <div class="admin-filter-bar">
    <div class="admin-filter-controls">
      <slot />
    </div>
    <div v-if="$slots.actions" class="admin-filter-actions">
      <slot name="actions" />
    </div>
  </div>
</template>

<style scoped>
.admin-filter-bar {
  display: flex;
  flex-direction: column;
  gap: 10px;
  margin-bottom: 16px;
}

.admin-filter-controls {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  min-width: 0;
}

.admin-filter-actions {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
}

@media (min-width: 769px) {
  .admin-filter-bar {
    flex-direction: row;
    align-items: center;
    justify-content: space-between;
  }

  .admin-filter-actions {
    flex-shrink: 0;
  }
}
</style>
