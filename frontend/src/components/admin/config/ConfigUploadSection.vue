<template>
  <section id="config-upload" class="card mt-5">
    <h3 class="card-title flex items-center gap-2">
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <path d="M3 6a2 2 0 012-2h4l2 2h8a2 2 0 012 2v10a2 2 0 01-2 2H5a2 2 0 01-2-2V6z" />
      </svg>
      文件上传配置
    </h3>
    <t-form layout="vertical">
      <t-form-item label="最大文件大小 (MB)">
        <t-input-number v-model="uploadConfig.maxFileSizeMB" :min="1" :max="1024" />
      </t-form-item>

      <t-form-item label="默认访问次数限制">
        <t-input-number v-model="uploadConfig.accessCountDefault" :min="-1" :max="1000000" :step="1" />
        <FormFieldHint>
          新上传文件的默认访问次数上限，-1 表示不限制
        </FormFieldHint>
      </t-form-item>

      <t-form-item label="最大可设访问次数">
        <t-input-number v-model="uploadConfig.accessCountMax" :min="-1" :max="1000000" :step="1" />
        <FormFieldHint>
          用户为单个文件可设置的访问次数上限，-1 表示不限制；设为正数后，用户不可设为更大值或无限制，且默认值须在 1 到该值之间
        </FormFieldHint>
      </t-form-item>

      <t-form-item label="过滤模式">
        <t-radio-group v-model="uploadConfig.fileTypeMode" class="upload-filter-options">
          <t-radio value="blacklist">黑名单模式（默认允许所有，禁止选中的类型）</t-radio>
          <t-radio value="whitelist">白名单模式（默认拒绝所有，仅允许选中的类型）</t-radio>
        </t-radio-group>
      </t-form-item>

      <t-form-item :label="uploadConfig.fileTypeMode === 'blacklist' ? '禁止上传的文件类型' : '允许上传的文件类型'">
        <div class="flex flex-wrap gap-2 mb-3">
          <span
            v-for="item in presetExtensions"
            :key="typeof item === 'string' ? item : item.ext"
            class="inline-flex items-center gap-1"
            :class="{ 'text-err': typeof item !== 'string' && item.danger && uploadConfig.fileTypeMode === 'blacklist' }"
          >
            <t-checkbox
              :checked="selectedExtensions.includes(typeof item === 'string' ? item : item.ext)"
              @change="(val: boolean) => emit('toggle-extension', typeof item === 'string' ? item : item.ext, val)"
            >
              {{ typeof item === 'string' ? item : item.ext }}
            </t-checkbox>
            <span
              v-if="typeof item !== 'string' && item.danger"
              class="inline-flex text-err cursor-help"
              title="黑名单模式下建议默认勾选禁止此类型"
              aria-label="高风险扩展名"
            >
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
                <line x1="12" y1="9" x2="12" y2="13" />
                <line x1="12" y1="17" x2="12.01" y2="17" />
              </svg>
            </span>
          </span>
        </div>
      </t-form-item>

      <t-form-item label="自定义后缀">
        <div class="flex flex-wrap items-center gap-2 mb-2">
          <div class="cfg-ext-input">
            <t-input
              v-model="customExtension"
              placeholder="如 .apk"
              autocomplete="off"
              name="custom-ext"
              @enter="emit('add-custom-extension')"
            />
          </div>
          <t-button variant="outline" :disabled="!customExtension.trim()" @click="emit('add-custom-extension')">
            添加
          </t-button>
        </div>
      </t-form-item>

      <t-form-item v-if="selectedExtensions.length > 0" label="已选后缀">
        <div class="flex flex-wrap gap-1.5 mb-2">
          <t-tag
            v-for="ext in selectedExtensions"
            :key="ext"
            :theme="uploadConfig.fileTypeMode === 'blacklist' ? 'danger' : 'success'"
            closable
            @close="emit('remove-extension', ext)"
          >
            {{ ext }}
          </t-tag>
        </div>
      </t-form-item>

      <t-form-item>
        <div class="flex flex-wrap items-center gap-2">
          <t-button theme="primary" :disabled="!loaded" @click="emit('save')">保存上传配置</t-button>
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
import type { PresetExtensionItem, UploadConfigState } from './types';

const uploadConfig = defineModel<UploadConfigState>('uploadConfig', { required: true });
const customExtension = defineModel<string>('customExtension', { required: true });

defineProps<{
  loaded: boolean;
  presetExtensions: PresetExtensionItem[];
  selectedExtensions: string[];
}>();

const emit = defineEmits<{
  'toggle-extension': [ext: string, checked: boolean];
  'remove-extension': [ext: string];
  'add-custom-extension': [];
  save: [];
  reload: [];
}>();
</script>

<style scoped>
.cfg-ext-input {
  max-width: 160px;
}

.upload-filter-options {
  display: grid;
  grid-template-columns: minmax(0, 1fr);
  gap: var(--space-2);
}

.upload-filter-options :deep(.t-radio) {
  margin-inline-end: 0;
  min-block-size: 44px;
}

.upload-filter-options :deep(.t-radio__label) {
  white-space: normal;
  overflow-wrap: anywhere;
}

@media (min-width: 481px) {
  .upload-filter-options {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-3);
  }

  .upload-filter-options :deep(.t-radio) {
    min-block-size: unset;
  }
}
</style>
