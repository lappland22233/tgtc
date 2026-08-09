<template>
  <div ref="viewport" class="upload-queue-list" @scroll.passive="handleScroll">
    <div class="upload-queue-list__spacer" :style="{ height: `${entries.length * ROW_HEIGHT}px` }">
      <div class="upload-queue-list__window" :style="{ transform: `translateY(${startIndex * ROW_HEIGHT}px)` }">
        <UploadQueueRow
          v-for="entry in visibleEntries"
          :key="entry.uid"
          :entry="entry"
          :allow-preview="allowPreview ?? false"
          @cancel="$emit('cancel', $event)"
        />
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue';
import type { QueueEntry } from '@/stores/upload';
import UploadQueueRow from './UploadQueueRow.vue';

const ROW_HEIGHT = 112;
const VIEWPORT_HEIGHT = 360;
const OVERSCAN = 4;
const props = defineProps<{ entries: QueueEntry[]; allowPreview?: boolean }>();
defineEmits<{ cancel: [uid: string] }>();
const scrollTop = ref(0);
const startIndex = computed(() => Math.max(0, Math.floor(scrollTop.value / ROW_HEIGHT) - OVERSCAN));
const visibleCount = Math.ceil(VIEWPORT_HEIGHT / ROW_HEIGHT) + OVERSCAN * 2;
const visibleEntries = computed(() => props.entries.slice(startIndex.value, startIndex.value + visibleCount));
function handleScroll(event: Event) {
  scrollTop.value = (event.currentTarget as HTMLElement).scrollTop;
}
</script>

<style scoped>
.upload-queue-list { height: 360px; overflow-y: auto; contain: strict; }
.upload-queue-list__spacer { position: relative; width: 100%; }
.upload-queue-list__window { position: absolute; inset: 0 0 auto; display: grid; gap: 8px; }
</style>
