<template>
  <div>
    <div class="page-header">
      <h1>系统配置</h1>
      <p>配置SMTP邮箱、文件上传限制和IP封禁</p>
    </div>

    <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 20px;">
      <!-- 认证配置 -->
      <div class="card">
        <h3 style="margin-bottom: 16px;">🔐 认证配置</h3>
        <t-form layout="vertical">
          <t-form-item label="允许新用户注册">
            <t-switch v-model="authConfig.registrationEnabled" />
            <div style="color: var(--text-secondary); font-size: 12px; margin-top: 4px;">
              关闭后，除第一个超级管理员外，禁止新用户注册
            </div>
          </t-form-item>
          <t-form-item label="邮箱验证码">
            <t-switch v-model="authConfig.emailVerificationEnabled" />
            <div style="color: var(--text-secondary); font-size: 12px; margin-top: 4px;">
              开启后，注册时需要验证邮箱验证码
            </div>
          </t-form-item>
          <t-form-item>
            <t-button theme="primary" @click="saveAuthConfig">保存认证配置</t-button>
          </t-form-item>
        </t-form>
      </div>

      <!-- SMTP配置 -->
      <div class="card">
        <h3 style="margin-bottom: 16px;">📧 SMTP邮箱配置</h3>
        <t-form layout="vertical">
          <t-form-item label="SMTP服务器">
            <t-input v-model="smtpConfig.host" placeholder="smtp.example.com" />
          </t-form-item>
          <t-form-item label="端口">
            <t-input-number v-model="smtpConfig.port" :min="1" :max="65535" />
          </t-form-item>
          <t-form-item label="使用SSL">
            <t-switch v-model="smtpConfig.secure" />
          </t-form-item>
          <t-form-item label="用户名">
            <t-input v-model="smtpConfig.user" placeholder="邮箱地址" />
          </t-form-item>
          <t-form-item label="密码">
            <t-input v-model="smtpConfig.password" type="password" placeholder="邮箱密码或授权码" />
          </t-form-item>
          <t-form-item label="发件人">
            <t-input v-model="smtpConfig.from" placeholder="显示名称" />
          </t-form-item>
          <t-form-item>
            <t-button theme="primary" @click="saveSMTPConfig">保存SMTP配置</t-button>
          </t-form-item>
        </t-form>
      </div>
    </div>

    <!-- 文件上传配置 -->
    <div class="card" style="margin-top: 20px;">
      <h3 style="margin-bottom: 16px;">📁 文件上传配置</h3>
      <t-form layout="vertical" style="max-width: 500px;">
        <t-form-item label="最大文件大小 (MB)">
          <t-input-number v-model="uploadConfig.maxFileSizeMB" :min="1" :max="1024" />
        </t-form-item>
        <t-form-item label="允许的文件类型">
          <t-input v-model="uploadConfig.allowedFileTypes" placeholder="image/*,application/pdf,application/zip" />
        </t-form-item>
        <t-form-item>
          <t-button theme="primary" @click="saveUploadConfig">保存上传配置</t-button>
        </t-form-item>
      </t-form>
    </div>

    <!-- IP封禁管理 -->
    <div class="card" style="margin-top: 20px;">
      <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 16px;">
        <h3>🚫 IP封禁管理</h3>
        <t-button theme="danger" @click="showBanDialog = true">+ 封禁IP</t-button>
      </div>

      <t-table :data="bannedIPs" :columns="ipColumns" row-key="id" hover>
        <template #isPermanent="{ row }">
          <t-tag :theme="row.isPermanent ? 'danger' : 'warning'" size="small">
            {{ row.isPermanent ? '永久' : '临时' }}
          </t-tag>
        </template>
        <template #expiresAt="{ row }">
          {{ row.expiresAt ? formatDate(row.expiresAt) : '-' }}
        </template>
        <template #operations="{ row }">
          <t-button size="small" theme="success" variant="text" @click="unbanIP(row.ip)">
            解封
          </t-button>
        </template>
      </t-table>
    </div>

    <t-dialog v-model:visible="showBanDialog" header="封禁IP" @confirm="banIP">
      <t-form layout="vertical">
        <t-form-item label="IP地址" name="ip">
          <t-input v-model="banForm.ip" placeholder="请输入要封禁的IP地址" />
        </t-form-item>
        <t-form-item label="封禁原因" name="reason">
          <t-input v-model="banForm.reason" placeholder="可选" />
        </t-form-item>
        <t-form-item label="永久封禁">
          <t-switch v-model="banForm.permanent" />
        </t-form-item>
      </t-form>
    </t-dialog>
  </div>
</template>

<script setup lang="ts">
import { ref, reactive, onMounted } from 'vue';
import { MessagePlugin } from 'tdesign-vue-next';
import { api } from '../../stores/auth';
import { getErrorMessage } from '../../utils/error';

const authConfig = ref({
  registrationEnabled: false,
  emailVerificationEnabled: false,
});

const smtpConfig = ref({
  host: '',
  port: 587,
  secure: false,
  user: '',
  password: '',
  from: '',
});

const uploadConfig = ref({
  maxFileSizeMB: 20,
  allowedFileTypes: 'image/*,application/pdf,application/zip,text/*',
});

const bannedIPs = ref<{ id: string; ip: string; reason: string | null; isPermanent: boolean; expiresAt: string | null; createdAt: string }[]>([]);
const showBanDialog = ref(false);
const banForm = reactive({ ip: '', reason: '', permanent: true });

const ipColumns = [
  { colKey: 'ip', title: 'IP地址', width: '150' },
  { colKey: 'reason', title: '原因', width: '200' },
  { colKey: 'isPermanent', title: '类型', width: '100' },
  { colKey: 'createdAt', title: '封禁时间', width: '150' },
  { colKey: 'expiresAt', title: '到期时间', width: '150' },
  { colKey: 'operations', title: '操作', width: '100' },
];

function formatDate(date: string) {
  return new Date(date).toLocaleDateString('zh-CN');
}

async function fetchAuthConfig() {
  const res = await api.get('/admin/auth-config');
  authConfig.value = res.data.data;
}

async function saveAuthConfig() {
  try {
    await api.put('/admin/auth-config', authConfig.value);
    MessagePlugin.success('认证配置已保存');
  } catch (error: unknown) {
    MessagePlugin.error(getErrorMessage(error));
  }
}

async function fetchSMTPConfig() {
  const res = await api.get('/admin/smtp');
  smtpConfig.value = res.data.data;
}

async function saveSMTPConfig() {
  try {
    await api.put('/admin/smtp', smtpConfig.value);
    MessagePlugin.success('SMTP配置已保存');
  } catch (error: unknown) {
    MessagePlugin.error(getErrorMessage(error));
  }
}

async function fetchUploadConfig() {
  const res = await api.get('/admin/upload-config');
  uploadConfig.value.maxFileSizeMB = Math.floor(res.data.data.maxFileSize / (1024 * 1024));
  uploadConfig.value.allowedFileTypes = res.data.data.allowedFileTypes;
}

async function saveUploadConfig() {
  try {
    await api.put('/admin/upload-config', {
      maxFileSize: uploadConfig.value.maxFileSizeMB * 1024 * 1024,
      allowedFileTypes: uploadConfig.value.allowedFileTypes,
    });
    MessagePlugin.success('上传配置已保存');
  } catch (error: unknown) {
    MessagePlugin.error(getErrorMessage(error));
  }
}

async function fetchBannedIPs() {
  const res = await api.get('/admin/banned-ips');
  bannedIPs.value = res.data.data;
}

async function banIP() {
  try {
    await api.post('/admin/banned-ips', banForm);
    MessagePlugin.success('IP已封禁');
    showBanDialog.value = false;
    banForm.ip = '';
    banForm.reason = '';
    banForm.permanent = true;
    fetchBannedIPs();
  } catch (error: unknown) {
    MessagePlugin.error(getErrorMessage(error));
  }
}

async function unbanIP(ip: string) {
  try {
    await api.delete(`/admin/banned-ips/${ip}`);
    MessagePlugin.success('IP已解封');
    fetchBannedIPs();
  } catch (error: unknown) {
    MessagePlugin.error(getErrorMessage(error));
  }
}

onMounted(() => {
  fetchAuthConfig();
  fetchSMTPConfig();
  fetchUploadConfig();
  fetchBannedIPs();
});
</script>
