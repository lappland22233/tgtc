<template>
  <div>
    <div class="page-header">
      <h1>系统配置</h1>
      <p>配置SMTP邮箱、文件上传限制和IP封禁</p>
    </div>

    <div class="config-grid" :class="{ 'mobile-single-col': isMobile }">
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
            <t-input v-model="smtpConfig.password" type="password" placeholder="邮箱密码或授权码" autocomplete="new-password" name="smtp-pass" />
          </t-form-item>
          <t-form-item label="发件人">
            <t-input v-model="smtpConfig.from" placeholder="显示名称" autocomplete="off" name="smtp-from" />
          </t-form-item>
          <t-form-item>
            <t-button theme="primary" @click="saveSMTPConfig">保存SMTP配置</t-button>
          </t-form-item>
        </t-form>
      </div>
    </div>

    <!-- 文件上传配置 -->
    <div class="card" style="margin-top: 20px;">
      <h3 style="margin-bottom: 16px; display: flex; align-items: center; gap: 8px;">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <path d="M3 6a2 2 0 012-2h4l2 2h8a2 2 0 012 2v10a2 2 0 01-2 2H5a2 2 0 01-2-2V6z" />
        </svg>
        文件上传配置
      </h3>
      <t-form layout="vertical">

        <!-- 最大文件大小 -->
        <t-form-item label="最大文件大小 (MB)">
          <t-input-number v-model="uploadConfig.maxFileSizeMB" :min="1" :max="1024" />
        </t-form-item>

        <!-- 默认访问次数限制（应用于新上传文件） -->
        <t-form-item label="默认访问次数限制">
          <t-input-number v-model="uploadConfig.accessCountDefault" :min="-1" :max="1000000" :step="1" />
          <div style="color: var(--text-secondary); font-size: 12px; margin-top: 4px;">
            新上传文件的默认访问次数上限，-1 表示不限制
          </div>
        </t-form-item>

        <!-- 最大可设访问次数（校验用户设置的上限） -->
        <t-form-item label="最大可设访问次数">
          <t-input-number v-model="uploadConfig.accessCountMax" :min="-1" :max="1000000" :step="1" />
          <div style="color: var(--text-secondary); font-size: 12px; margin-top: 4px;">
            用户为单个文件可设置的访问次数上限，-1 表示不限制；设为正数后，用户不可设为更大值或无限制，且默认值须在 1 到该值之间
          </div>
        </t-form-item>

        <!-- 模式切换 -->
        <t-form-item label="过滤模式">
          <t-radio-group v-model="uploadConfig.fileTypeMode">
            <t-radio value="blacklist">黑名单模式（默认允许所有，禁止选中的类型）</t-radio>
            <t-radio value="whitelist">白名单模式（默认拒绝所有，仅允许选中的类型）</t-radio>
          </t-radio-group>
        </t-form-item>

        <!-- 预设扩展名勾选 -->
        <t-form-item :label="uploadConfig.fileTypeMode === 'blacklist' ? '禁止上传的文件类型' : '允许上传的文件类型'">
          <div style="display: flex; flex-wrap: wrap; gap: 8px; margin-bottom: 12px;">
            <span
              v-for="item in presetExtensions"
              :key="typeof item === 'string' ? item : item.ext"
              :style="{
                display: 'inline-flex',
                alignItems: 'center',
                gap: '4px',
                color: typeof item !== 'string' && item.danger && uploadConfig.fileTypeMode === 'blacklist' ? 'var(--color-danger)' : undefined,
              }"
            >
              <t-checkbox
                :checked="selectedExtensions.includes(typeof item === 'string' ? item : item.ext)"
                @change="(val: boolean) => toggleExtension(typeof item === 'string' ? item : item.ext, val)"
              >
                {{ typeof item === 'string' ? item : item.ext }}
              </t-checkbox>
              <span
                v-if="typeof item !== 'string' && item.danger"
                style="font-size: 10px; color: var(--color-danger); cursor: help;"
                title="黑名单模式下建议默认勾选禁止此类型"
              >&#9888;</span>
            </span>
          </div>
        </t-form-item>

        <!-- 自定义后缀输入 -->
        <t-form-item label="自定义后缀">
          <div style="display: flex; gap: 8px; margin-bottom: 8px;">
            <t-input
              v-model="customExtension"
              placeholder="如 .apk" style="max-width: 160px;"
              @enter="addCustomExtension"
              autocomplete="off"
              name="custom-ext"
            />
            <t-button variant="outline" :disabled="!customExtension.trim()" @click="addCustomExtension">
              添加
            </t-button>
          </div>
        </t-form-item>

        <!-- 已选列表 -->
        <t-form-item v-if="selectedExtensions.length > 0" label="已选后缀">
          <div style="display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 8px;">
            <t-tag
              v-for="ext in selectedExtensions"
              :key="ext"
              :theme="uploadConfig.fileTypeMode === 'blacklist' ? 'danger' : 'success'"
              closable
              @close="removeExtension(ext)"
            >
              {{ ext }}
            </t-tag>
          </div>
        </t-form-item>

        <t-form-item>
          <t-button theme="primary" @click="saveUploadConfig">保存上传配置</t-button>
        </t-form-item>
      </t-form>
    </div>

    <!-- 文件缓存配置 -->
    <div class="card" style="margin-top: 20px;">
      <h3>文件缓存</h3>
      <t-form label-width="160px">
        <t-form-item label="缓存总大小上限 (GB)">
          <t-input-number v-model="cacheConfig.maxSizeGB" :min="1" :max="1000" :step="1" />
          <span style="margin-left: 8px; font-size: 12px; color: var(--td-text-color-secondary);">超过此值停止写入新缓存</span>
        </t-form-item>
        <t-form-item label="磁盘最低剩余空间 (GB)">
          <t-input-number
            v-model="cacheConfig.minFreeDiskGB"
            :min="0.5"
            :max="100"
            :step="0.5"
          />
          <span style="margin-left: 8px; font-size: 12px; color: var(--td-text-color-secondary);">低于此值停止缓存，防止磁盘爆满</span>
        </t-form-item>
        <t-form-item label="缓存有效期 (天)">
          <t-input-number v-model="cacheConfig.ttlDays" :min="1" :max="365" :step="1" />
          <span style="margin-left: 8px; font-size: 12px; color: var(--td-text-color-secondary);">超过此时间的缓存文件自动清理</span>
        </t-form-item>
        <t-form-item>
          <t-button theme="primary" @click="saveCacheConfig">保存缓存配置</t-button>
        </t-form-item>
      </t-form>
    </div>

    <!-- IP封禁管理 -->
    <div class="card" style="margin-top: 20px;">
      <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 16px; flex-wrap: wrap; gap: 12px;">
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
          <t-input v-model="banForm.ip" placeholder="请输入要封禁的IP地址" autocomplete="off" name="config-ban-ip" />
        </t-form-item>
        <t-form-item label="封禁原因" name="reason">
          <t-input v-model="banForm.reason" placeholder="可选" autocomplete="off" name="config-ban-reason" />
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
import MessagePlugin from '@/utils/message';
import { useMobile } from '../../composables/useMobile';
import { api } from '../../stores/auth';
import { getErrorMessage } from '../../utils/error';

const isMobile = useMobile();

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
  fileTypeMode: 'blacklist' as 'blacklist' | 'whitelist',
  fileTypeFilter: '',
  accessCountDefault: -1,
  accessCountMax: -1,
});

const cacheConfig = ref({
  maxSizeGB: 10,
  minFreeDiskGB: 1,
  ttlDays: 3,
});

// 预设常用扩展名（危险类型已标注）
const presetExtensions = [
  '.zip', '.rar', '.7z', '.tar.gz',
  '.png', '.jpeg', '.jpg', '.webp', '.gif',
  '.mp3', '.mp4', '.flac',
  { ext: '.exe', danger: true },
  { ext: '.sh', danger: true },
  { ext: '.js', danger: true },
  { ext: '.css', danger: false },
];

const selectedExtensions = ref<string[]>([]);
const customExtension = ref('');

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

async function fetchAuthConfig(): Promise<boolean> {
  try {
    const res = await api.get('/admin/auth-config');
    authConfig.value = res.data.data ?? authConfig.value;
    return true;
  } catch (err) {
    console.error('获取认证配置失败', err);
    return false;
  }
}

async function saveAuthConfig() {
  try {
    await api.put('/admin/auth-config', authConfig.value);
    MessagePlugin.success('认证配置已保存');
  } catch (error: unknown) {
    MessagePlugin.error(getErrorMessage(error));
  }
}

async function fetchSMTPConfig(): Promise<boolean> {
  try {
    const res = await api.get('/admin/smtp');
    smtpConfig.value = res.data.data ?? smtpConfig.value;
    return true;
  } catch (err) {
    console.error('获取SMTP配置失败', err);
    return false;
  }
}

async function saveSMTPConfig() {
  try {
    await api.put('/admin/smtp', smtpConfig.value);
    MessagePlugin.success('SMTP配置已保存');
  } catch (error: unknown) {
    MessagePlugin.error(getErrorMessage(error));
  }
}

function toggleExtension(ext: string, checked: boolean) {
  if (checked) {
    if (!selectedExtensions.value.includes(ext)) {
      selectedExtensions.value.push(ext);
    }
  } else {
    removeExtension(ext);
  }
}

function removeExtension(ext: string) {
  selectedExtensions.value = selectedExtensions.value.filter(e => e !== ext);
}

function addCustomExtension() {
  let ext = customExtension.value.trim().toLowerCase();
  if (!ext) return;
  if (!ext.startsWith('.')) {
    ext = '.' + ext;
  }
  if (!selectedExtensions.value.includes(ext)) {
    selectedExtensions.value.push(ext);
  }
  customExtension.value = '';
}

async function fetchUploadConfig(): Promise<boolean> {
  try {
    const res = await api.get('/admin/upload-config');
    const data = res.data.data;
    if (!data) return true; // 后端返回空数据时保留默认配置，避免访问 null 抛错
    uploadConfig.value.maxFileSizeMB = Math.floor(data.maxFileSize / (1024 * 1024));
    uploadConfig.value.fileTypeMode = data.fileTypeMode || 'blacklist';
    uploadConfig.value.fileTypeFilter = data.fileTypeFilter || '';
    uploadConfig.value.accessCountDefault = Number.isInteger(data.accessCountDefault) ? data.accessCountDefault : -1;
    uploadConfig.value.accessCountMax = Number.isInteger(data.accessCountMax) ? data.accessCountMax : -1;
    selectedExtensions.value = data.fileTypeFilter
      ? data.fileTypeFilter.split(',').map((s: string) => s.trim()).filter(Boolean)
      : [];
    return true;
  } catch (err) {
    console.error('获取上传配置失败', err);
    return false;
  }
}

async function saveUploadConfig() {
  // 前端一致性校验（后端亦会兜底）：存在最大值(>0)时，默认值须为 1..max
  const { accessCountDefault: def, accessCountMax: max } = uploadConfig.value;
  if (max > 0 && (def <= 0 || def > max)) {
    MessagePlugin.warning('存在最大访问次数限制时，默认访问次数必须为 1 到最大值之间');
    return;
  }
  try {
    await api.put('/admin/upload-config', {
      maxFileSize: uploadConfig.value.maxFileSizeMB * 1024 * 1024,
      fileTypeMode: uploadConfig.value.fileTypeMode,
      fileTypeFilter: selectedExtensions.value.join(','),
      accessCountDefault: def,
      accessCountMax: max,
    });
    uploadConfig.value.fileTypeFilter = selectedExtensions.value.join(',');
    MessagePlugin.success('上传配置已保存');
  } catch (error: unknown) {
    MessagePlugin.error(getErrorMessage(error));
  }
}

async function fetchCacheConfig(): Promise<boolean> {
  try {
    const res = await api.get('/admin/cache-config');
    cacheConfig.value = res.data.data ?? cacheConfig.value;
    return true;
  } catch (err) {
    console.error('获取缓存配置失败', err);
    return false;
  }
}

async function saveCacheConfig() {
  try {
    await api.put('/admin/cache-config', cacheConfig.value);
    MessagePlugin.success('缓存配置已保存');
  } catch (error: unknown) {
    MessagePlugin.error(getErrorMessage(error));
  }
}

async function fetchBannedIPs(): Promise<boolean> {
  try {
    const res = await api.get('/admin/banned-ips');
    bannedIPs.value = res.data.data ?? [];
    return true;
  } catch (err) {
    console.error('获取封禁IP列表失败', err);
    return false;
  }
}

async function banIP() {
  const ip = banForm.ip.trim();
  if (!ip) {
    MessagePlugin.warning('请输入 IP 地址');
    return;
  }
  if (!isValidIP(ip)) {
    MessagePlugin.warning('IP 地址格式无效，请输入合法的 IPv4 或 IPv6 地址');
    return;
  }
  try {
    await api.post('/admin/banned-ips', { ...banForm, ip });
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

function isValidIP(ip: string): boolean {
  const ipv4Re = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;
  const m = ip.match(ipv4Re);
  if (m) {
    return m.slice(1).every((o) => {
      const n = parseInt(o, 10);
      return n >= 0 && n <= 255 && String(n) === o;
    });
  }
  // 完整 IPv6 校验：8 组完整形式 / :: 压缩形式 / link-local / IPv4 映射与嵌入，
  // 避免宽松正则让 ":::" 等无效地址通过
  const ipv6Re = /^(?:([0-9a-fA-F]{1,4}:){7}[0-9a-fA-F]{1,4}|([0-9a-fA-F]{1,4}:){1,7}:|([0-9a-fA-F]{1,4}:){1,6}:[0-9a-fA-F]{1,4}|([0-9a-fA-F]{1,4}:){1,5}(?::[0-9a-fA-F]{1,4}){1,2}|([0-9a-fA-F]{1,4}:){1,4}(?::[0-9a-fA-F]{1,4}){1,3}|([0-9a-fA-F]{1,4}:){1,3}(?::[0-9a-fA-F]{1,4}){1,4}|([0-9a-fA-F]{1,4}:){1,2}(?::[0-9a-fA-F]{1,4}){1,5}|[0-9a-fA-F]{1,4}:(?::[0-9a-fA-F]{1,4}){1,6}|:(?:(?::[0-9a-fA-F]{1,4}){1,7}|:)|fe80:(?::[0-9a-fA-F]{0,4}){0,4}%[0-9a-zA-Z]+|::(?:ffff(?::0{1,4})?:)?(?:(?:25[0-5]|(?:2[0-4]|1?[0-9])?[0-9])\.){3}(?:25[0-5]|(?:2[0-4]|1?[0-9])?[0-9])|(?:[0-9a-fA-F]{1,4}:){1,4}:(?:(?:25[0-5]|(?:2[0-4]|1?[0-9])?[0-9])\.){3}(?:25[0-5]|(?:2[0-4]|1?[0-9])?[0-9]))$/;
  return ipv6Re.test(ip);
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
  Promise.allSettled([
    fetchAuthConfig(),
    fetchSMTPConfig(),
    fetchUploadConfig(),
    fetchCacheConfig(),
    fetchBannedIPs(),
  ]).then((results) => {
    const failed = results.filter(
      (r) => r.status === 'fulfilled' && r.value === false,
    ).length;
    if (failed > 0) {
      MessagePlugin.warning(`${failed} 项配置加载失败，当前显示默认值`);
    }
  });
});
</script>

<style scoped>
.config-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 20px;
}

@media (max-width: 768px) {
  .config-grid.mobile-single-col {
    grid-template-columns: 1fr;
  }
}
</style>
