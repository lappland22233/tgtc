<template>
  <div class="form-field-hint" :class="toneClass">
    <slot />
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue';

const props = withDefaults(defineProps<{
  tone?: 'muted' | 'warn' | 'err';
}>(), {
  tone: 'muted',
});

const toneClass = computed(() => {
  if (props.tone === 'warn') return 'text-warn';
  if (props.tone === 'err') return 'text-err';
  return 'text-ink-muted';
});
</script>

<style scoped>
.form-field-hint {
  flex: 1 0 100%;
  inline-size: 100%;
  font-size: 12px;
  line-height: 1.5;
  margin-top: 6px;
}
</style>
