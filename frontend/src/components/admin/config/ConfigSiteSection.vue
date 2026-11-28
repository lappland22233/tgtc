<template>
  <section id="config-site" class="card mb-5">
    <h3 class="card-title">网站标题</h3>
    <t-form label-align="top">
      <t-form-item label="浏览器标题">
        <t-input
          v-model="siteConfig.title"
          :maxlength="200"
          placeholder="请输入网站标题"
          autocomplete="off"
          name="site-title"
        />
        <FormFieldHint>
          保存后立即同步左侧导航标题与浏览器标签标题。
        </FormFieldHint>
      </t-form-item>
      <t-form-item>
        <div class="flex flex-wrap items-center gap-2">
          <t-button theme="primary" :disabled="!loaded" @click="emit('save')">保存网站标题</t-button>
          <t-button v-if="!loaded" variant="outline" @click="emit('reload')">重新加载</t-button>
        </div>
        <FormFieldHint v-if="!loaded" tone="warn">
          配置加载失败，当前显示默认值。为避免覆盖服务端配置，已禁用保存，请先重新加载。
        </FormFieldHint>
      </t-form-item>
    </t-form>
  </section>
</template>

<script setup lang="ts">
import FormFieldHint from '../FormFieldHint.vue';
import type { SiteConfigState } from './types';

const siteConfig = defineModel<SiteConfigState>('siteConfig', { required: true });

defineProps<{
  loaded: boolean;
}>();

const emit = defineEmits<{
  save: [];
  reload: [];
}>();
</script>
