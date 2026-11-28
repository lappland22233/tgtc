<template>
  <div class="metric-card">
    <div class="metric-label">
      <slot name="label">{{ label }}</slot>
    </div>
    <div class="metric-value" :class="valueToneClass">
      <slot>{{ value }}</slot>
    </div>
    <div v-if="sub !== undefined || $slots.sub" class="metric-sub">
      <slot name="sub">{{ sub }}</slot>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue';

export type MetricTone = 'default' | 'brand' | 'ok' | 'warn' | 'err';

const props = withDefaults(defineProps<{
  label?: string;
  value?: string | number;
  sub?: string;
  tone?: MetricTone;
}>(), {
  label: '',
  value: '',
  sub: undefined,
  tone: 'default',
});

const TONE_CLASS_MAP: Record<MetricTone, string> = {
  default: '',
  brand: 'text-brand',
  ok: 'text-ok',
  warn: 'text-warn',
  err: 'text-err',
};

const valueToneClass = computed(() => TONE_CLASS_MAP[props.tone] ?? '');
</script>
