<template>
  <div id="config-auth" class="config-grid">
    <!-- 认证配置 -->
    <section class="card mb-0">
      <h3 class="card-title">认证配置</h3>
      <t-form layout="vertical">
        <t-form-item label="允许新用户注册">
          <t-switch v-model="authConfig.registrationEnabled" />
          <FormFieldHint>
            关闭后，除第一个超级管理员外，禁止新用户注册
          </FormFieldHint>
        </t-form-item>
        <t-form-item label="邮箱验证码">
          <t-switch
            :value="authConfig.emailVerificationEnabled"
            @change="(val: boolean) => emit('toggle-email-verification', val)"
          />
          <FormFieldHint>
            开启后，注册时需要验证邮箱验证码
          </FormFieldHint>
        </t-form-item>
        <t-form-item label="Cloudflare Turnstile">
          <t-switch v-model="authConfig.turnstileEnabled" />
          <FormFieldHint>
            开启后可在后续注册流程中启用 Turnstile 人机验证
          </FormFieldHint>
        </t-form-item>
        <t-form-item label="Turnstile Site Key">
          <t-input
            v-model="authConfig.siteKey"
            placeholder="请输入 Cloudflare Site Key"
            autocomplete="off"
            name="turnstile-site-key"
          />
        </t-form-item>
        <t-form-item label="Turnstile Secret Key">
          <t-input
            v-model="authConfig.secretKey"
            type="password"
            placeholder="留空则保留原 Secret Key"
            autocomplete="new-password"
            name="turnstile-secret-key"
          />
          <FormFieldHint>
            Secret Key 仅超级管理员可写，服务端加密保存且不会返回明文
          </FormFieldHint>
        </t-form-item>
        <t-form-item label="Turnstile 可信 Hostname">
          <t-input
            v-model="authConfig.hostnames"
            placeholder="例如 example.com，多个域名用英文逗号分隔"
            autocomplete="off"
            name="turnstile-hostnames"
          />
          <FormFieldHint>
            必须与 Cloudflare Widget 配置的 Hostnames 一致；开启验证时不能为空
          </FormFieldHint>
        </t-form-item>
        <t-form-item>
          <div class="flex flex-wrap items-center gap-2">
            <t-button theme="primary" :disabled="!authLoaded" @click="emit('save-auth')">保存认证配置</t-button>
            <t-button v-if="!authLoaded" variant="outline" @click="emit('reload-auth')">重新加载</t-button>
          </div>
          <FormFieldHint v-if="!authLoaded" tone="warn">
            配置加载失败，当前显示默认值。为避免覆盖服务端配置，已禁用保存，请先重新加载。
          </FormFieldHint>
        </t-form-item>
      </t-form>
    </section>

    <!-- SMTP配置 -->
    <section id="config-smtp" class="card mb-0">
      <h3 class="card-title">SMTP 邮箱配置</h3>
      <t-form layout="vertical">
        <t-form-item label="SMTP服务器">
          <t-input v-model="smtpConfig.host" placeholder="smtp.example.com" autocomplete="off" name="smtp-host" />
        </t-form-item>
        <t-form-item label="端口">
          <t-input-number v-model="smtpConfig.port" :min="1" :max="65535" />
        </t-form-item>
        <t-form-item label="使用SSL">
          <t-switch v-model="smtpConfig.secure" />
        </t-form-item>
        <t-form-item label="用户名">
          <t-input v-model="smtpConfig.user" placeholder="邮箱地址" autocomplete="off" name="smtp-user" />
        </t-form-item>
        <t-form-item label="密码">
          <t-input
            v-model="smtpConfig.password"
            type="password"
            placeholder="邮箱密码或授权码，留空则保留原密码"
            autocomplete="new-password"
            name="smtp-pass"
          />
        </t-form-item>
        <t-form-item label="发件人">
          <t-input v-model="smtpConfig.from" placeholder="显示名称" autocomplete="off" name="smtp-from" />
        </t-form-item>
        <t-form-item>
          <div class="flex flex-wrap items-center gap-2">
            <t-button theme="primary" :disabled="!smtpLoaded" @click="emit('save-smtp')">保存SMTP配置</t-button>
            <t-button v-if="!smtpLoaded" variant="outline" @click="emit('reload-smtp')">重新加载</t-button>
          </div>
          <FormFieldHint v-if="!smtpLoaded" tone="warn">
            配置加载失败，当前显示默认值。为避免覆盖服务端配置，已禁用保存，请先重新加载。
          </FormFieldHint>
        </t-form-item>
      </t-form>

      <!-- 发送测试邮件 -->
      <div class="smtp-test">
        <div class="smtp-test__title">发送测试邮件</div>
        <div class="smtp-test__row">
          <div class="smtp-test__input">
            <t-input
              v-model="testEmailRecipient"
              placeholder="收件人邮箱，如 user@example.com"
              autocomplete="off"
              name="smtp-test-recipient"
              @enter="emit('send-test-email')"
            />
          </div>
          <t-button theme="primary" variant="outline" :loading="sendingTestEmail" @click="emit('send-test-email')">
            发送
          </t-button>
        </div>
        <FormFieldHint>使用服务器当前生效的邮箱配置发送，未保存的修改不会参与测试</FormFieldHint>
      </div>
    </section>
  </div>
</template>

<script setup lang="ts">
import FormFieldHint from '../FormFieldHint.vue';
import type { AuthConfigState, SmtpConfigState } from './types';

const authConfig = defineModel<AuthConfigState>('authConfig', { required: true });
const smtpConfig = defineModel<SmtpConfigState>('smtpConfig', { required: true });
const testEmailRecipient = defineModel<string>('testEmailRecipient', { required: true });

defineProps<{
  authLoaded: boolean;
  smtpLoaded: boolean;
  sendingTestEmail: boolean;
}>();

const emit = defineEmits<{
  'toggle-email-verification': [value: boolean];
  'save-auth': [];
  'reload-auth': [];
  'save-smtp': [];
  'reload-smtp': [];
  'send-test-email': [];
}>();
</script>

<style scoped>
.config-grid {
  display: grid;
  grid-template-columns: minmax(0, 1fr);
  gap: 20px;
}

@media (min-width: 769px) {
  .config-grid {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
}

.smtp-test {
  margin-top: var(--space-4);
  padding-top: var(--space-4);
  border-top: 1px solid var(--border-default);
}

.smtp-test__title {
  font-size: 13px;
  font-weight: 600;
  color: var(--text-primary);
  margin-bottom: var(--space-2);
}

.smtp-test__row {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-2);
}

.smtp-test__input {
  flex: 1 1 100%;
  min-width: 0;
}

@media (min-width: 481px) {
  .smtp-test__input {
    flex: 1 1 auto;
  }
}

.smtp-test__row :deep(.t-button) {
  flex-shrink: 0;
}
</style>
