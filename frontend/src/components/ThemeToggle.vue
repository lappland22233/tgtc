<template>
  <button
    v-if="variant === 'icon'"
    type="button"
    class="theme-toggle-btn"
    :aria-label="toggleLabel"
    :title="toggleLabel"
    @click="cycleTheme"
  >
    <svg
      v-if="isDark"
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="1.5"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
    >
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41" />
    </svg>
    <svg
      v-else
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="1.5"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
    >
      <path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z" />
    </svg>
  </button>

  <div v-else class="theme-segmented" role="radiogroup" aria-label="界面主题">
    <button
      v-for="opt in options"
      :key="opt.value"
      type="button"
      role="radio"
      class="theme-segmented-item"
      :class="{ 'is-active': themePreference === opt.value }"
      :aria-checked="themePreference === opt.value"
      @click="setTheme(opt.value)"
    >
      <svg
        v-if="opt.value === 'light'"
        width="15"
        height="15"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="1.5"
        stroke-linecap="round"
        stroke-linejoin="round"
        aria-hidden="true"
      >
        <circle cx="12" cy="12" r="4" />
        <path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41" />
      </svg>
      <svg
        v-else-if="opt.value === 'dark'"
        width="15"
        height="15"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="1.5"
        stroke-linecap="round"
        stroke-linejoin="round"
        aria-hidden="true"
      >
        <path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z" />
      </svg>
      <svg
        v-else
        width="15"
        height="15"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="1.5"
        stroke-linecap="round"
        stroke-linejoin="round"
        aria-hidden="true"
      >
        <rect x="2" y="3" width="20" height="14" rx="2" />
        <path d="M8 21h8M12 17v4" />
      </svg>
      <span>{{ opt.label }}</span>
    </button>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import { useTheme, type ThemePreference } from '@/composables/useTheme';

withDefaults(
  defineProps<{
    variant?: 'icon' | 'segmented';
  }>(),
  { variant: 'icon' },
);

const { themePreference, isDark, setTheme, cycleTheme } = useTheme();

const toggleLabel = computed(() => (isDark.value ? '切换至浅色主题' : '切换至深色主题'));

const options: Array<{ value: ThemePreference; label: string }> = [
  { value: 'light', label: '浅色' },
  { value: 'dark', label: '深色' },
  { value: 'system', label: '跟随系统' },
];
</script>

<style scoped>
.theme-toggle-btn {
  display: inline-grid;
  place-items: center;
  width: 44px;
  height: 44px;
  flex: none;
  padding: 0;
  border: 0;
  border-radius: var(--radius-md);
  background: transparent;
  color: var(--workspace-text);
  cursor: pointer;
  transition:
    background-color var(--duration-fast) var(--ease-out-expo),
    color var(--duration-fast) var(--ease-out-expo);
}

.theme-toggle-btn:hover {
  background: var(--workspace-selected);
  color: var(--workspace-accent);
}

.theme-toggle-btn:focus-visible {
  outline: 2px solid var(--workspace-accent);
  outline-offset: 2px;
}

.theme-segmented {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: var(--space-1);
  padding: var(--space-1);
  border: 1px solid var(--workspace-border);
  border-radius: var(--radius-md);
  background: var(--workspace-canvas);
}

.theme-segmented-item {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 5px;
  min-height: 44px;
  padding: 6px 8px;
  border: 0;
  border-radius: calc(var(--radius-md) - 2px);
  background: transparent;
  color: var(--workspace-muted);
  font: inherit;
  font-size: 12px;
  font-weight: 500;
  white-space: nowrap;
  cursor: pointer;
  transition:
    background-color var(--duration-fast) var(--ease-out-expo),
    color var(--duration-fast) var(--ease-out-expo);
}

.theme-segmented-item:hover {
  color: var(--workspace-text);
}

.theme-segmented-item.is-active {
  background: var(--workspace-surface);
  color: var(--workspace-accent);
  font-weight: 600;
  box-shadow: var(--shadow-sm);
}

.theme-segmented-item:focus-visible {
  outline: 2px solid var(--workspace-accent);
  outline-offset: 1px;
}

@media (min-width: 769px) {
  .theme-toggle-btn {
    width: 36px;
    height: 36px;
  }

  .theme-segmented-item {
    min-height: 36px;
  }
}

@media (pointer: coarse) {
  .theme-toggle-btn {
    width: 44px;
    height: 44px;
  }

  .theme-segmented-item {
    min-height: 44px;
  }
}
</style>
