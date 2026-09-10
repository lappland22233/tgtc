import { computed, ref } from 'vue';
import { defineStore } from 'pinia';
import { api } from './auth';

export const DEFAULT_MAX_FILE_SIZE_BYTES = 20 * 1024 * 1024;

export interface UploadValidationConfig {
  maxFileSize: number;
  fileTypeMode: 'blacklist' | 'whitelist';
  fileTypeFilter: string[];
  /** 小盘严格路径：所有文件走分片链路且队列仅允许一个活动文件。 */
  strictSerialUpload: boolean;
}

type RawUploadValidationConfig = {
  maxFileSize?: unknown;
  fileTypeMode?: unknown;
  fileTypeFilter?: unknown;
  strictSerialUpload?: unknown;
};

function normalizeConfig(value: unknown): UploadValidationConfig {
  const data: RawUploadValidationConfig = value && typeof value === 'object' ? value as RawUploadValidationConfig : {};
  const maxFileSize = Number(data.maxFileSize);
  const filter = data.fileTypeFilter;
  return {
    maxFileSize: Number.isFinite(maxFileSize) && maxFileSize > 0 ? maxFileSize : DEFAULT_MAX_FILE_SIZE_BYTES,
    fileTypeMode: data.fileTypeMode === 'whitelist' ? 'whitelist' : 'blacklist',
    fileTypeFilter: Array.isArray(filter)
      ? filter.filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
      : typeof filter === 'string'
        ? filter.split(',').map((item) => item.trim()).filter(Boolean)
        : [],
    strictSerialUpload: data.strictSerialUpload === true,
  };
}

/**
 * 已登录用户的上传规则单一来源。请求使用认证 API，绝不复用匿名公共配置；
 * 首次拖拽会等待规则加载后再校验，失败不会消费文件载荷，后续操作可重试。
 */
export const useUploadConfigStore = defineStore('upload-config', () => {
  const config = ref<UploadValidationConfig>({
    maxFileSize: DEFAULT_MAX_FILE_SIZE_BYTES,
    fileTypeMode: 'blacklist',
    fileTypeFilter: [],
    strictSerialUpload: false,
  });
  const loaded = ref(false);
  const loading = ref(false);
  const loadError = ref<unknown>(null);
  let inflight: Promise<boolean> | null = null;

  const maxFileSizeMB = computed(() => Math.round((config.value.maxFileSize / 1024 / 1024) * 100) / 100);
  const acceptTypes = computed(() => config.value.fileTypeMode === 'whitelist' ? config.value.fileTypeFilter.join(',') : '');

  function setConfig(value: unknown): void {
    config.value = normalizeConfig(value);
    loaded.value = true;
    loadError.value = null;
  }

  function fetchUploadConfig(): Promise<boolean> {
    if (inflight) return inflight;
    loading.value = true;
    loadError.value = null;
    inflight = api.get('/files/upload-config')
      .then((res) => {
        setConfig(res.data?.data);
        return true;
      })
      .catch((error: unknown) => {
        loadError.value = error;
        return false;
      })
      .finally(() => {
        loading.value = false;
        inflight = null;
      });
    return inflight;
  }

  /** M7：登出/切换账号时丢弃上传规则缓存，换账号后重新拉取当前账号的规则。 */
  function reset() {
    config.value = {
      maxFileSize: DEFAULT_MAX_FILE_SIZE_BYTES,
      fileTypeMode: 'blacklist',
      fileTypeFilter: [],
      strictSerialUpload: false,
    };
    loaded.value = false;
    loading.value = false;
    loadError.value = null;
  }

  return { config, loaded, loading, loadError, maxFileSizeMB, acceptTypes, setConfig, fetchUploadConfig, reset };
});
