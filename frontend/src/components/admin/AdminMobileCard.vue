<template>
  <div class="mobile-card">
    <div v-if="$slots.head || $slots.badges" class="mobile-card-head">
      <div class="mobile-card-title-wrap">
        <slot name="head" />
      </div>
      <div v-if="$slots.badges" class="mobile-card-badges">
        <slot name="badges" />
      </div>
    </div>
    <div v-if="$slots.default" class="mobile-card-body">
      <slot />
    </div>
    <div v-if="$slots.meta" class="mobile-card-meta">
      <slot name="meta" />
    </div>
    <div v-if="$slots.actions" class="mobile-card-actions">
      <slot name="actions" />
    </div>
  </div>
</template>

<style scoped>
.mobile-card-title-wrap {
  min-width: 0;
  flex: 1;
}

.mobile-card-badges {
  display: inline-flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 4px;
  flex-shrink: 0;
}
</style>
