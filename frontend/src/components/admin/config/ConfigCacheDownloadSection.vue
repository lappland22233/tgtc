<template>
  <!-- 文件缓存配置 -->
  <section id="config-cache" class="card mt-5">
    <h3 class="card-title">文件缓存</h3>
    <t-form label-align="top">
      <t-form-item label="缓存总大小上限 (GB)">
        <div class="cfg-control-row">
          <t-input-number v-model="cacheConfig.maxSizeGB" :min="1" :max="1000" :step="1" />
          <span class="cfg-control-hint">超过此值先按最近最少使用淘汰旧缓存，仍不足则改走临时中转</span>
        </div>
      </t-form-item>
      <t-form-item label="磁盘最低剩余空间 (GB)">
        <div class="cfg-control-row">
          <t-input-number v-model="cacheConfig.minFreeDiskGB" :min="0.5" :max="100" :step="0.5" />
          <span class="cfg-control-hint">缓存与下载临时占用的最低保留空间，低于此值不再新建缓存或完整中转</span>
        </div>
      </t-form-item>
      <t-form-item label="缓存有效期 (天)">
        <div class="cfg-control-row">
          <t-input-number v-model="cacheConfig.ttlDays" :min="1" :max="365" :step="1" />
          <span class="cfg-control-hint">超过此时间的缓存文件自动清理（正在下载中的文件会跳过本轮清理）</span>
        </div>
      </t-form-item>
      <t-form-item label="无缓存模式">
        <div class="cfg-control-row">
          <t-switch :value="cacheConfig.noCacheMode" @change="(val: boolean) => emit('toggle-no-cache', val)" />
          <span class="cfg-control-hint">开启后不发布正式缓存，下载仍会写入临时中转文件（可重放给同一文件的并发下载）；Range 请求保持 206，但冷文件仍会完整回源，上游带宽压力增大</span>
        </div>
      </t-form-item>
      <t-form-item>
        <div class="flex flex-wrap items-center gap-2">
          <t-button theme="primary" :disabled="!cacheLoaded" @click="emit('save-cache')">保存缓存配置</t-button>
          <t-button v-if="!cacheLoaded" variant="outline" @click="emit('reload-cache')">重新加载</t-button>
        </div>
        <FormFieldHint v-if="!cacheLoaded" tone="warn">
          配置加载失败，当前显示默认值。为避免覆盖服务端配置，已禁用保存，请先重新加载。
        </FormFieldHint>
      </t-form-item>
    </t-form>
  </section>

  <!-- 下载资源调度：磁盘预约/排队与直通兜底 -->
  <section id="config-download" class="card mt-5">
    <h3 class="card-title mb-1">下载资源调度</h3>
    <p class="section-hint mb-4">
      下载按「预测占用 → 预约 → 排队」调度：已获得资源的下裁任务不会被新任务抢占，
      空间紧张时新任务排队等待。任何已上传文件都可以下载，完整暂存不可行时会自动改用受限缓冲直通。
    </p>
    <t-form label-align="top">
      <t-form-item label="总预约上限 (GB)">
        <div class="cfg-control-row">
          <t-input-number v-model="downloadConfig.maxReservedGB" :min="0" :max="10000" :step="1" />
          <span class="cfg-control-hint">所有在途任务未写入预约之和的上限，0 表示只受物理空间约束</span>
        </div>
      </t-form-item>
      <t-form-item label="上游权重预算">
        <div class="cfg-control-row">
          <t-input-number v-model="downloadConfig.maxConcurrentUpstreams" :min="1" :max="128" :step="1" />
          <span class="cfg-control-hint">
            冷回源的全局「权重预算」：大文件占 8、中等文件占 2、小文件占 1；自动扩缩容开启时按有效 Bot 数映射 min(128, max(8, n×16))（1 个 → 16，2 个 → 32，4 个 → 64，8 个 → 128，上限 128）
          </span>
        </div>
      </t-form-item>
      <t-form-item label="队列等待策略">
        <div class="cfg-control-row">
          <div class="cfg-policy-select">
            <t-select v-model="downloadConfig.upstreamQueuePolicy" :options="queuePolicyOptions" />
          </div>
          <span class="cfg-control-hint">
            适配优先：队首大文件暂时放不下时，仅在前 8 个等待项内放过可适配的任务，避免小文件被 4GB 队首阻塞到超时
          </span>
        </div>
      </t-form-item>
      <t-form-item label="预算自动扩缩容">
        <div class="cfg-control-row">
          <t-switch v-model="downloadConfig.autoCapacityEnabled" />
          <span class="cfg-control-hint">
            按「有效 Bot 数」（已启用 + 存储 Chat + 健康 + 已有 ready 副本）自动调整权重预算；关闭后只保留人工设置
          </span>
        </div>
      </t-form-item>
      <t-form-item label="优先用户账号回源">
        <div class="cfg-control-row">
          <t-switch v-model="downloadConfig.preferUserAccount" />
          <span class="cfg-control-hint">
            开启后下载优先用 Premium 用户账号（MTProto）回源，命中失败自动回退 Bot 链路；关闭即回到纯 Bot 行为（临时能力，约 30 天后关闭回退）
          </span>
        </div>
      </t-form-item>
      <t-form-item label="用户账号并发上限">
        <div class="cfg-control-row">
          <t-input-number v-model="downloadConfig.userStreamMaxConcurrency" :min="1" :max="32" :step="1" />
          <span class="cfg-control-hint">
            单个 user 账号同时开出的 MTProto 回源流数（1-32）；过高更容易触发 Telegram 限流，过低会让并发下载提前回退 Bot
          </span>
        </div>
      </t-form-item>
      <t-form-item label="用户账号失败冷却 (秒)">
        <div class="cfg-control-row">
          <t-input-number v-model="downloadConfig.userFailureCooldownSeconds" :min="1" :max="600" :step="5" />
          <span class="cfg-control-hint">
            仅用于 network / other 类瞬时失败；限流仍按 Telegram 的 retry_after 冷却，认证类 30 分钟、权限类 10 分钟不变
          </span>
        </div>
      </t-form-item>
      <t-form-item label="排队上限 (个)">
        <div class="cfg-control-row">
          <t-input-number v-model="downloadConfig.queueCapacity" :min="1" :max="10000" :step="1" />
          <span class="cfg-control-hint">等待磁盘或上游的名额上限，超过后下载请求直接返回「服务器繁忙」</span>
        </div>
      </t-form-item>
      <t-form-item label="排队等待上限 (秒)">
        <div class="cfg-control-row">
          <t-input-number v-model="downloadConfig.queueTimeoutSeconds" :min="5" :max="86400" :step="30" />
          <span class="cfg-control-hint">单个任务最长排队时间，超时返回可重试状态并释放名额</span>
        </div>
      </t-form-item>
      <t-form-item label="临时中转宽限 (秒)">
        <div class="cfg-control-row">
          <t-input-number v-model="downloadConfig.spoolGraceSeconds" :min="0" :max="3600" :step="10" />
          <span class="cfg-control-hint">最后一个下载者断开后临时文件的保留时间，便于断点续传复用</span>
        </div>
      </t-form-item>
      <t-form-item label="直通缓冲窗口 (MB)">
        <div class="cfg-control-row">
          <t-input-number v-model="downloadConfig.directWindowMB" :min="1" :max="4" :step="1" />
          <span class="cfg-control-hint">
            完整暂存不可行时的直通缓冲上限（1-4MB，推荐 1MB）：窗口即单请求的预读内存上限，与文件总大小无关
          </span>
        </div>
      </t-form-item>
      <t-form-item label="下载任务保留 (秒)">
        <div class="cfg-control-row">
          <t-input-number v-model="downloadConfig.taskRetentionSeconds" :min="60" :max="86400" :step="60" />
          <span class="cfg-control-hint">下载任务状态（排队/可下载）的保留时间</span>
        </div>
      </t-form-item>
      <t-form-item>
        <div class="flex flex-wrap items-center gap-2">
          <t-button theme="primary" :disabled="!downloadLoaded" @click="emit('save-download')">保存调度配置</t-button>
          <t-button variant="outline" @click="emit('refresh-runtime')">刷新运行状态</t-button>
          <t-button v-if="!downloadLoaded" variant="outline" @click="emit('reload-download')">重新加载</t-button>
        </div>
        <FormFieldHint v-if="!downloadLoaded" tone="warn">
          配置加载失败，当前显示默认值。为避免覆盖服务端配置，已禁用保存，请先重新加载。
        </FormFieldHint>
      </t-form-item>
    </t-form>

    <div v-if="downloadRuntime" class="download-runtime">
      <div class="download-runtime__item">
        <span class="download-runtime__label">磁盘可用</span>
        <span class="download-runtime__value">{{ formatBytes(downloadRuntime.freeBytes) }}</span>
      </div>
      <div class="download-runtime__item">
        <span class="download-runtime__label">未写入预约</span>
        <span class="download-runtime__value">{{ formatBytes(downloadRuntime.reservedRemainingBytes) }}</span>
      </div>
      <div class="download-runtime__item">
        <span class="download-runtime__label">排队任务</span>
        <span class="download-runtime__value">{{ downloadRuntime.waitingDiskTasks }} 磁盘 / {{ downloadRuntime.waitingUpstreamTasks }} 上游</span>
      </div>
      <div class="download-runtime__item">
        <span class="download-runtime__label">活跃回源</span>
        <span class="download-runtime__value">
          {{ downloadRuntime.activeUpstreams }} 个 / 权重 {{ downloadRuntime.activeUpstreamWeight ?? 0 }} ÷
          {{ downloadRuntime.maxConcurrentUpstreams }}
        </span>
      </div>
      <div class="download-runtime__item">
        <span class="download-runtime__label">队列策略</span>
        <span class="download-runtime__value">{{ queuePolicyText(downloadRuntime.upstreamQueuePolicy) }}</span>
      </div>
      <div class="download-runtime__item">
        <span class="download-runtime__label">缓存占用</span>
        <span class="download-runtime__value">
          {{ formatBytes(downloadRuntime.cacheCommittedBytes) }} / {{ formatBytes(downloadRuntime.cacheMaxBytes) }}
        </span>
      </div>
      <div class="download-runtime__item">
        <span class="download-runtime__label">最长等待</span>
        <span class="download-runtime__value">
          磁盘 {{ Math.round(downloadRuntime.oldestDiskWaitMs / 1000) }} 秒
          / 上游 {{ Math.round((downloadRuntime.oldestUpstreamWaitMs ?? 0) / 1000) }} 秒
        </span>
      </div>
      <div class="download-runtime__item">
        <span class="download-runtime__label">直通与跟随流</span>
        <span class="download-runtime__value">
          直通 {{ downloadRuntime.streams?.directStreams ?? 0 }} 个（窗口合计
          {{ formatBytes(downloadRuntime.streams?.directWindowBytesTotal) }}） ·
          构建 {{ downloadRuntime.streams?.buildSessions ?? 0 }} · spool
          {{ downloadRuntime.streams?.spoolConsumers ?? 0 }} 消费者
        </span>
      </div>
      <div class="download-runtime__item">
        <span class="download-runtime__label">进程内存</span>
        <span class="download-runtime__value">
          RSS {{ formatBytes(downloadRuntime.memory?.rssBytes) }} · JS 堆
          {{ formatBytes(downloadRuntime.memory?.heapUsedBytes) }} · external
          {{ formatBytes(downloadRuntime.memory?.externalBytes) }} · arrayBuffers
          {{ formatBytes(downloadRuntime.memory?.arrayBuffersBytes) }}
        </span>
      </div>
      <div class="download-runtime__item">
        <span class="download-runtime__label">follower 缓冲分配</span>
        <span class="download-runtime__value">
          {{ downloadRuntime.streams?.followerBufferAllocations ?? 0 }} 次（256KB/次，累计）
        </span>
      </div>
      <div class="download-runtime__item">
        <span class="download-runtime__label">副本有效目标</span>
        <span class="download-runtime__value">
          <template v-if="replicaTarget">
            {{ replicaTarget.effectiveTarget }} 路（配置 {{ replicaTarget.configured }}，可承载账号
            {{ replicaTarget.eligibleCount }}）
          </template>
          <template v-else>未知（需账号池生效；在账号池页面查看审计详情）</template>
        </span>
      </div>
    </div>
    <FormFieldHint v-else class="text-ink-subtle">
      运行状态需要后端支持（/admin/download-runtime），当前不可用。
    </FormFieldHint>
  </section>
</template>

<script setup lang="ts">
import FormFieldHint from '../FormFieldHint.vue';
import type { CacheConfigState, DownloadConfigState, DownloadRuntime, ReplicaTargetInfo } from './types';

const cacheConfig = defineModel<CacheConfigState>('cacheConfig', { required: true });
const downloadConfig = defineModel<DownloadConfigState>('downloadConfig', { required: true });

defineProps<{
  cacheLoaded: boolean;
  downloadLoaded: boolean;
  downloadRuntime: DownloadRuntime | null;
  replicaTarget: ReplicaTargetInfo | null;
  queuePolicyOptions: Array<{ value: string; label: string }>;
  queuePolicyText: (policy: DownloadRuntime['upstreamQueuePolicy']) => string;
  formatBytes: (value: number | undefined) => string;
}>();

const emit = defineEmits<{
  'toggle-no-cache': [value: boolean];
  'save-cache': [];
  'reload-cache': [];
  'save-download': [];
  'refresh-runtime': [];
  'reload-download': [];
}>();
</script>

<style scoped>
.cfg-control-row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px 12px;
  width: 100%;
}

.cfg-control-row :deep(.t-input-number),
.cfg-control-row :deep(.t-switch) {
  flex-shrink: 0;
}

.cfg-control-hint {
  flex: 1 1 240px;
  min-width: 0;
  font-size: 12px;
  line-height: 1.5;
  color: var(--text-secondary);
}

.cfg-policy-select {
  flex-shrink: 0;
  width: min(100%, 220px);
}

.cfg-policy-select :deep(.t-select) {
  width: 100%;
}

.download-runtime {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(min(100%, 180px), 1fr));
  gap: var(--space-3);
  margin-top: var(--space-4);
  padding-top: var(--space-4);
  border-top: 1px solid var(--border-default);
}

.download-runtime__item {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
  padding: var(--space-3);
  border: 1px solid var(--border-default);
  border-radius: var(--radius-sm);
  background: var(--color-bg-overlay);
}

.download-runtime__label {
  font-size: 11px;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: var(--text-tertiary);
}

.download-runtime__value {
  font-size: 14px;
  font-weight: 500;
  color: var(--text-primary);
}
</style>
