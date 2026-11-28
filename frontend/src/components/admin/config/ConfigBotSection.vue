<template>
  <section id="config-bot" class="card mt-5">
    <h3 class="card-title mb-1">Telegram Bot 设置</h3>
    <p class="section-hint mb-4">
      Bot 文件直链的有效期、每日额度、切日时区与站点域名。保存后立即生效，无需重启；
      已签发的直链沿用签发时的有效期。
    </p>

    <h4 class="bot-group-title">基础配置</h4>
    <t-form label-align="top">
      <t-form-item label="直链有效期（小时）">
        <t-input-number v-model="botConfig.linkTtlHours" :min="1" :max="720" :step="1" />
        <FormFieldHint>1–720 小时</FormFieldHint>
      </t-form-item>
      <t-form-item label="每日额度（个/天）">
        <t-input-number v-model="botConfig.dailyLimit" :min="1" :max="100000" :step="1" />
        <FormFieldHint>非白名单用户每日可签发的文件数；白名单用户不受限</FormFieldHint>
      </t-form-item>
      <t-form-item label="切日时区">
        <t-input
          v-model="botConfig.quotaTimezone"
          placeholder="如 Asia/Shanghai"
          autocomplete="off"
          name="tg-bot-timezone"
        />
        <FormFieldHint>IANA 时区名，用于每日额度按日重置</FormFieldHint>
      </t-form-item>
    </t-form>

    <section class="bot-storage-mode" aria-labelledby="bot-storage-mode-title">
      <h4 id="bot-storage-mode-title" class="bot-group-title">存储后端模式</h4>
      <t-alert v-if="!botConfig.telegramStorageChatConfigured" class="bot-storage-mode__warning" theme="warning">
        <template #message>
          尚未配置 Telegram 存储群组（<code>TELEGRAM_CHAT_ID</code> 或账号池存储群）。可选用纯 Google 存储模式，直接转存 Bot 收到的文件。
        </template>
      </t-alert>
      <t-form label-align="top">
        <t-form-item label="Bot 文件存储模式">
          <div class="bot-storage-mode__field">
            <t-radio-group
              v-model="botConfig.storageMode"
              class="bot-storage-mode__choices"
              aria-label="Bot 文件存储模式"
              aria-describedby="bot-storage-mode-description"
            >
              <t-radio value="telegram" :disabled="!botConfig.telegramStorageChatConfigured">
                原生 Telegram 存储模式
                <span v-if="!botConfig.telegramStorageChatConfigured" class="bot-storage-mode__unavailable">（未配置存储群）</span>
              </t-radio>
              <t-radio value="gdrive">纯 Google 存储模式</t-radio>
            </t-radio-group>
            <p id="bot-storage-mode-description" class="bot-storage-mode__description">
              {{ botConfig.storageMode === 'gdrive' ? '文件入站时自动转存至 Google 云端硬盘并生成下载直链。直链到期后，云端硬盘中的副本将永久删除。' : '文件保存在 Telegram 官方服务器，通过本地回源流式提供下载。' }}
            </p>
            <div v-if="botConfig.storageMode === 'gdrive'" class="bot-storage-mode__oauth">
              <p>Google Drive 存储需要 OAuth 客户端凭据和存储账号池授权。</p>
              <router-link :to="{ name: 'AdminStorageBackends' }">配置 OAuth 客户端与账号池</router-link>
            </div>
          </div>
        </t-form-item>
      </t-form>
    </section>

    <h4 class="bot-group-title">站点链接设置</h4>
    <t-form label-align="top">
      <t-form-item label="域名模式">
        <t-radio-group v-model="botConfig.linkDomainMode">
          <t-radio value="auto">自动获取</t-radio>
          <t-radio value="manual">手动设置</t-radio>
        </t-radio-group>
      </t-form-item>
      <t-form-item label="站点域名">
        <div class="flex flex-wrap items-center gap-2 w-full">
          <div class="flex-1 min-w-0">
            <t-input
              v-model="botConfig.linkDomain"
              :disabled="botConfig.linkDomainMode !== 'manual'"
              placeholder="https://text.lappland.top"
              autocomplete="off"
              name="tg-bot-domain"
            />
          </div>
          <t-button
            variant="outline"
            :disabled="botConfig.linkDomainMode !== 'manual'"
            :loading="detectingDomain"
            @click="emit('detect-domain')"
          >自动获取</t-button>
        </div>
        <FormFieldHint>须为 http(s)://host[:port]，不含路径；自动模式优先使用 APP_URL</FormFieldHint>
      </t-form-item>
      <t-form-item label="当前生效域名">
        <div class="bot-effective-domain">{{ effectiveDomain || '未配置（无法签发直链）' }}</div>
        <FormFieldHint v-if="!cryptoAvailable" tone="warn">
          未配置 TELEGRAM_BOT_ENCRYPTION_KEY：Bot 直链无法回放完整链接，/links 仅显示前缀
        </FormFieldHint>
      </t-form-item>
      <t-form-item>
        <div class="flex flex-wrap items-center gap-2">
          <t-button theme="primary" :loading="saving" :disabled="!loaded" @click="emit('save')">保存 Bot 配置</t-button>
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
import type { BotConfigState } from './types';

const botConfig = defineModel<BotConfigState>('botConfig', { required: true });

defineProps<{
  loaded: boolean;
  effectiveDomain: string;
  cryptoAvailable: boolean;
  detectingDomain: boolean;
  saving: boolean;
}>();

const emit = defineEmits<{
  'detect-domain': [];
  save: [];
  reload: [];
}>();
</script>

<style scoped>
.bot-group-title {
  margin: 0 0 12px;
  font-size: 14px;
  font-weight: 600;
  color: var(--text-primary);
}

.bot-group-title:not(:first-of-type) {
  margin-top: 20px;
}

.bot-storage-mode {
  margin-block: var(--space-5);
  max-inline-size: 42rem;
}

.bot-storage-mode__warning {
  margin-block-end: var(--space-3);
  overflow-wrap: anywhere;
}

.bot-storage-mode__field,
.bot-storage-mode__choices {
  display: grid;
  min-inline-size: 0;
  gap: var(--space-2);
}

.bot-storage-mode__choices :deep(.t-radio) {
  margin-inline-end: 0;
  min-block-size: 28px;
}

.bot-storage-mode__choices :deep(.t-radio__label) {
  white-space: normal;
  overflow-wrap: anywhere;
}

.bot-storage-mode__unavailable,
.bot-storage-mode__description,
.bot-storage-mode__oauth {
  color: var(--text-secondary);
  font-size: 12px;
  line-height: 1.65;
}

.bot-storage-mode__description,
.bot-storage-mode__oauth p {
  margin: 0;
}

.bot-storage-mode__oauth {
  padding: var(--space-2) var(--space-3);
  background: var(--color-bg-overlay);
  border: 1px solid var(--border-default);
  border-radius: var(--radius-md);
}

.bot-storage-mode__oauth a {
  display: inline-flex;
  align-items: center;
  min-block-size: 32px;
  color: var(--text-accent);
  font-weight: 500;
}

@media (pointer: coarse) {
  .bot-storage-mode__choices :deep(.t-radio),
  .bot-storage-mode__oauth a {
    min-block-size: 44px;
  }
}

.bot-effective-domain {
  font-family: var(--font-mono);
  font-size: 13px;
  color: var(--text-accent);
  word-break: break-all;
}
</style>
