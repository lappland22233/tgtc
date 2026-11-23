<template>
  <dialog
    ref="dialog"
    :id="id"
    class="workspace-drawer"
    :class="placement"
    :aria-label="label"
    @cancel.prevent="emit('close')"
    @click.self="emit('close')"
  >
    <div class="workspace-drawer-inner">
      <slot />
    </div>
  </dialog>
</template>

<script setup lang="ts">
import { useTemplateRef, watchPostEffect } from 'vue';

const props = defineProps<{
  id: string;
  label: string;
  open: boolean;
  placement: 'left' | 'right' | 'bottom';
}>();
const emit = defineEmits<{ close: [] }>();
const dialog = useTemplateRef<HTMLDialogElement>('dialog');

watchPostEffect(() => {
  const element = dialog.value;
  if (!element || element.open === props.open) return;
  if (props.open) element.showModal();
  else element.close();
});
</script>

<style>
.workspace-drawer {
  position: fixed;
  inset: auto 0 0;
  width: 100%;
  max-width: none;
  max-height: 85vh;
  max-height: 85dvh;
  margin: 0;
  padding: 0;
  border: 1px solid var(--workspace-border);
  border-radius: var(--radius-xl) var(--radius-xl) 0 0;
  background: var(--workspace-canvas);
  color: var(--workspace-text);
  overflow: auto;
  overscroll-behavior: contain;
}

.workspace-drawer::backdrop {
  background: color-mix(in srgb, var(--workspace-archive) 42%, transparent);
}

.workspace-drawer.left,
.workspace-drawer.right {
  inset: 0 auto 0 0;
  width: min(100%, 320px);
  height: 100%;
  max-height: none;
  border-radius: 0;
}

.workspace-drawer.right {
  inset: 0 0 0 auto;
  width: min(100%, 360px);
}

.workspace-drawer-inner { padding-bottom: env(safe-area-inset-bottom); }
</style>
