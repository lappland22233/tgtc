<template>
  <div class="auth-gate">
    <header class="auth-gate-header">
      <div class="auth-gate-brand">
        <WorkspaceBrand />
        <ThemeToggle variant="icon" />
      </div>
    </header>
    <main class="auth-gate-content" aria-labelledby="auth-gate-title">
      <section class="auth-gate-panel">
        <h1 id="auth-gate-title">{{ title }}</h1>
        <slot />
        <footer v-if="$slots.footer" class="auth-gate-footer">
          <slot name="footer" />
        </footer>
      </section>
    </main>
  </div>
</template>

<script setup lang="ts">
import WorkspaceBrand from '@/components/WorkspaceBrand.vue';
import ThemeToggle from '@/components/ThemeToggle.vue';

defineProps<{ title: string }>();
</script>

<style scoped>
.auth-gate {
  --auth-control-radius: var(--radius-md);
  --td-border-level-2-color: color-mix(in srgb, var(--workspace-muted) 65%, var(--workspace-border));
  display: flex;
  flex-direction: column;
  min-height: 100vh;
  min-height: 100dvh;
  background: var(--workspace-canvas);
  color: var(--workspace-text);
}

.auth-gate-header {
  border-bottom: 1px solid var(--workspace-border);
  background: var(--workspace-surface);
}

.auth-gate-brand {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-3);
  width: min(100% - 32px, 1120px);
  min-height: var(--workspace-header-height);
  margin-inline: auto;
}

.auth-gate-content {
  display: grid;
  flex: 1;
  align-items: start;
  justify-items: center;
  padding: clamp(24px, 6vh, 64px) 12px;
}

.auth-gate-panel {
  width: min(100%, 430px);
  min-width: 0;
  padding: 24px 16px;
  border: 1px solid var(--workspace-border);
  border-radius: var(--radius-xl);
  background: var(--workspace-surface);
}

.auth-gate-panel h1 {
  margin: 0 0 23px;
  font-size: clamp(26px, 4vw, 34px);
  font-weight: 680;
  letter-spacing: -0.035em;
  line-height: 1.2;
}

.auth-gate-panel :deep(.t-form__item) {
  margin-bottom: 17px;
}

.auth-gate-panel :deep(.t-form__item:last-child) {
  margin-bottom: 0;
}

.auth-gate-panel :deep(.t-form__label) {
  color: var(--workspace-text);
  font-weight: 560;
}

.auth-gate-panel :deep(.t-input) {
  border-radius: var(--auth-control-radius);
}

.auth-gate-panel :deep(.t-input__inner) {
  color: var(--workspace-text);
  font-size: 16px;
}

.auth-gate-panel :deep(.t-input__inner::placeholder) {
  color: var(--workspace-muted);
}

.auth-gate-panel :deep(.gate-submit.t-button) {
  min-height: 44px;
  border-radius: var(--auth-control-radius);
  color: var(--workspace-on-accent);
  font-weight: 600;
}

.auth-gate-panel :deep(.gate-submit.t-button:focus-visible),
.auth-gate-footer :deep(a:focus-visible) {
  outline: 2px solid var(--workspace-accent);
  outline-offset: 2px;
}

.auth-gate-footer {
  margin-top: 24px;
  padding-top: 16px;
  border-top: 1px solid var(--workspace-border);
  color: var(--workspace-muted);
  font-size: 14px;
}

.auth-gate-footer :deep(a) {
  color: var(--workspace-accent);
  font-weight: 600;
}

.auth-gate-footer :deep(a:hover) {
  text-decoration: underline;
  text-underline-offset: 3px;
}

@media (min-width: 481px) {
  .auth-gate-content {
    align-items: center;
  }

  .auth-gate-panel {
    padding: 32px;
  }

  .auth-gate-panel :deep(.t-input__inner) {
    font-size: 14px;
  }
}
</style>
