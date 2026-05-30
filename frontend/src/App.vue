<template>
  <t-config-provider :global-config="globalConfig">
    <router-view />
  </t-config-provider>
</template>

<script setup lang="ts">
import { ref } from 'vue';

const globalConfig = ref({
  theme: 'dark',
});
</script>
