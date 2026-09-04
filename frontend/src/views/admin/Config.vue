<template>
  <div>
    <div class="page-header">
      <h1>系统配置</h1>
      <p>配置SMTP邮箱、文件上传限制和IP封禁</p>
    </div>

    <div class="card" style="margin-bottom: 20px;">
      <h3 style="margin-bottom: 16px;">网站标题</h3>
      <t-form layout="vertical">
        <t-form-item label="浏览器标题">
          <t-input v-model="siteConfig.title" :maxlength="200" placeholder="请输入网站标题" autocomplete="off" name="site-title" />
          <div style="color: var(--text-secondary); font-size: 12px; margin-top: 4px;">
            保存后，新打开页面会使用此标题。
          </div>
        </t-form-item>
        <t-form-item>
          <div style="display: flex; align-items: center; gap: 8px;">
            <t-button theme="primary" :disabled="!blockLoadState.site" @click="saveSiteConfig">保存网站标题</t-button>
            <t-button v-if="!blockLoadState.site" variant="outline" @click="fetchSiteConfig">重新加载</t-button>
          </div>
          <div v-if="!blockLoadState.site" style="color: var(--color-warning); font-size: 12px; margin-top: 4px;">
            配置加载失败，当前显示默认值。为避免覆盖服务端配置，已禁用保存，请先重新加载。
          </div>
        </t-form-item>
      </t-form>
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
            <t-switch :value="authConfig.emailVerificationEnabled" @change="onEmailVerificationToggle" />
            <div style="color: var(--text-secondary); font-size: 12px; margin-top: 4px;">
              开启后，注册时需要验证邮箱验证码
            </div>
          </t-form-item>
          <t-form-item label="Cloudflare Turnstile">
            <t-switch v-model="authConfig.turnstileEnabled" />
            <div style="color: var(--text-secondary); font-size: 12px; margin-top: 4px;">
              开启后可在后续注册流程中启用 Turnstile 人机验证
            </div>
          </t-form-item>
          <t-form-item label="Turnstile Site Key">
            <t-input v-model="authConfig.siteKey" placeholder="请输入 Cloudflare Site Key" autocomplete="off" name="turnstile-site-key" />
          </t-form-item>
          <t-form-item label="Turnstile Secret Key">
            <t-input v-model="authConfig.secretKey" type="password" placeholder="留空则保留原 Secret Key" autocomplete="new-password" name="turnstile-secret-key" />
            <div style="color: var(--text-secondary); font-size: 12px; margin-top: 4px;">
              Secret Key 仅超级管理员可写，服务端加密保存且不会返回明文
            </div>
          </t-form-item>
          <t-form-item label="Turnstile 可信 Hostname">
            <t-input v-model="authConfig.hostnames" placeholder="例如 example.com，多个域名用英文逗号分隔" autocomplete="off" name="turnstile-hostnames" />
            <div style="color: var(--text-secondary); font-size: 12px; margin-top: 4px;">
              必须与 Cloudflare Widget 配置的 Hostnames 一致；开启验证时不能为空
            </div>
          </t-form-item>
          <t-form-item>
            <div style="display: flex; align-items: center; gap: 8px;">
              <t-button theme="primary" :disabled="!blockLoadState.auth" @click="saveAuthConfig">保存认证配置</t-button>
              <t-button v-if="!blockLoadState.auth" variant="outline" @click="fetchAuthConfig">重新加载</t-button>
            </div>
            <div v-if="!blockLoadState.auth" style="color: var(--color-warning); font-size: 12px; margin-top: 4px;">
              配置加载失败，当前显示默认值。为避免覆盖服务端配置，已禁用保存，请先重新加载。
            </div>
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
            <t-input v-model="smtpConfig.password" type="password" placeholder="邮箱密码或授权码，留空则保留原密码" autocomplete="new-password" name="smtp-pass" />
          </t-form-item>
          <t-form-item label="发件人">
            <t-input v-model="smtpConfig.from" placeholder="显示名称" autocomplete="off" name="smtp-from" />
          </t-form-item>
          <t-form-item>
            <div style="display: flex; align-items: center; gap: 8px;">
              <t-button theme="primary" :disabled="!blockLoadState.smtp" @click="saveSMTPConfig">保存SMTP配置</t-button>
              <t-button v-if="!blockLoadState.smtp" variant="outline" @click="fetchSMTPConfig">重新加载</t-button>
            </div>
            <div v-if="!blockLoadState.smtp" style="color: var(--color-warning); font-size: 12px; margin-top: 4px;">
              配置加载失败，当前显示默认值。为避免覆盖服务端配置，已禁用保存，请先重新加载。
            </div>
          </t-form-item>
        </t-form>

        <!-- 发送测试邮件 -->
        <div class="smtp-test">
          <div class="smtp-test__title">发送测试邮件</div>
          <div class="smtp-test__row">
            <t-input
              v-model="testEmailRecipient"
              placeholder="收件人邮箱，如 user@example.com"
              autocomplete="off"
              name="smtp-test-recipient"
              @enter="sendTestEmail"
            />
            <t-button theme="primary" variant="outline" :loading="sendingTestEmail" @click="sendTestEmail">
              发送
            </t-button>
          </div>
          <div class="smtp-test__hint">使用服务器当前生效的邮箱配置发送，未保存的修改不会参与测试</div>
        </div>
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
          <div style="display: flex; align-items: center; gap: 8px;">
            <t-button theme="primary" :disabled="!blockLoadState.upload" @click="saveUploadConfig">保存上传配置</t-button>
            <t-button v-if="!blockLoadState.upload" variant="outline" @click="fetchUploadConfig">重新加载</t-button>
          </div>
          <div v-if="!blockLoadState.upload" style="color: var(--color-warning); font-size: 12px; margin-top: 4px;">
            配置加载失败，当前显示默认值。为避免覆盖服务端配置，已禁用保存，请先重新加载。
          </div>
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
        <t-form-item label="无缓存模式">
          <t-switch :value="cacheConfig.noCacheMode" @change="onNoCacheModeToggle" />
          <span style="margin-left: 8px; font-size: 12px; color: var(--td-text-color-secondary);">开启后所有文件下载实时回源直通，不读写本地缓存；Range 请求退化为完整下载，上游带宽压力增大</span>
        </t-form-item>
        <t-form-item>
          <div style="display: flex; align-items: center; gap: 8px;">
            <t-button theme="primary" :disabled="!blockLoadState.cache" @click="saveCacheConfig">保存缓存配置</t-button>
            <t-button v-if="!blockLoadState.cache" variant="outline" @click="fetchCacheConfig">重新加载</t-button>
          </div>
          <div v-if="!blockLoadState.cache" style="color: var(--color-warning); font-size: 12px; margin-top: 4px;">
            配置加载失败，当前显示默认值。为避免覆盖服务端配置，已禁用保存，请先重新加载。
          </div>
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
        <t-form-item label="封禁类型">
          <t-radio-group v-model="banForm.permanent">
            <t-radio :value="false">临时封禁</t-radio>
            <t-radio :value="true">永久封禁</t-radio>
          </t-radio-group>
        </t-form-item>
        <t-form-item v-if="!banForm.permanent" label="封禁时长">
          <t-input-number
            v-model="banForm.durationHours"
            :min="1"
            :max="720"
            style="width: 120px"
          />
          <span style="margin-left: 8px; color: var(--text-secondary); font-size: 13px">小时</span>
        </t-form-item>
      </t-form>
    </t-dialog>
  </div>
</template>

<script setup lang="ts">
import { ref, reactive, onMounted, onBeforeUnmount, watch } from 'vue';
import { onBeforeRouteLeave } from 'vue-router';
import { DialogPlugin } from 'tdesign-vue-next';
import MessagePlugin from '@/utils/message';
import { useMobile } from '../../composables/useMobile';
import { api } from '../../stores/auth';
import { getErrorMessage } from '../../utils/error';
import { isValidIP } from '../../utils/ip';

const isMobile = useMobile();

// 各配置区块加载状态：加载失败时禁用对应保存按钮并阻止提交，防止用默认值覆盖服务端真实配置（G15-04）
const blockLoadState = reactive({
  site: false as boolean,
  auth: false as boolean,
  smtp: false as boolean,
  upload: false as boolean,
  cache: false as boolean,
});

const siteConfig = ref({
  title: '',
});

const authConfig = ref({
  registrationEnabled: false,
  emailVerificationEnabled: false,
  turnstileEnabled: false,
  siteKey: '',
  secretKey: '',
  hostnames: '',
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
  noCacheMode: false,
});

// 未保存离开防护（G15-17）：任一配置表单被修改且未保存时置脏，
// 触发 beforeunload / 路由离开确认，避免误操作丢失修改。
const dirty = ref(false);
// 初始加载期置 true，避免 fetch 回填表单值时误触发 dirty（非用户编辑）
const suppressDirty = ref(true);
function markDirty() {
  if (suppressDirty.value) return;
  if (!dirty.value) dirty.value = true;
}
function markClean() {
  dirty.value = false;
}
// 深度监听各配置对象，任何字段变化即标记脏；保存成功后由 markClean 复位
watch([authConfig, smtpConfig, uploadConfig, cacheConfig], () => {
  markDirty();
}, { deep: true });

// 浏览器关闭/刷新拦截
function handleBeforeUnload(e: BeforeUnloadEvent) {
  if (!dirty.value) return;
  e.preventDefault();
  e.returnValue = '';
}
onMounted(() => {
  window.addEventListener('beforeunload', handleBeforeUnload);
});
onBeforeUnmount(() => {
  window.removeEventListener('beforeunload', handleBeforeUnload);
});
// SPA 路由离开确认
onBeforeRouteLeave(() => {
  if (!dirty.value) return true;
  return new Promise<boolean>((resolve) => {
    const dialog = DialogPlugin.confirm({
      header: '未保存的修改',
      body: '当前有未保存的配置修改，离开后将丢失。确定要离开吗？',
      confirmBtn: '放弃修改并离开',
      cancelBtn: '留在本页',
      onConfirm: () => {
        dialog.destroy();
        resolve(true);
      },
      onClose: () => {
        dialog.destroy();
        resolve(false);
      },
    });
  });
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
const banForm = reactive({ ip: '', reason: '', permanent: true, durationHours: 6 });

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

async function fetchSiteConfig(): Promise<boolean> {
  try {
    const res = await api.get('/public-config');
    const title = res.data.data?.siteTitle;
    siteConfig.value.title = typeof title === 'string' ? title : '';
    blockLoadState.site = true;
    return true;
  } catch (err) {
    console.error('获取网站标题失败', err);
    blockLoadState.site = false;
    return false;
  }
}

async function saveSiteConfig() {
  if (!blockLoadState.site) {
    MessagePlugin.warning('网站标题加载失败，无法保存。请先点击"重新加载"');
    return;
  }
  const title = siteConfig.value.title.trim();
  if (!title) {
    MessagePlugin.warning('网站标题不能为空');
    return;
  }
  try {
    await api.put('/admin/config', {
      key: 'SITE_TITLE',
      value: title,
      description: '网站浏览器标题',
    });
    siteConfig.value.title = title;
    MessagePlugin.success('网站标题已保存');
    markClean();
  } catch (error: unknown) {
    MessagePlugin.error(getErrorMessage(error));
  }
}

async function fetchAuthConfig(): Promise<boolean> {
  try {
    const res = await api.get('/admin/auth-config');
    const data = res.data.data;
    if (data) {
      // Secret Key 只返回掩码；重新加载时保留当前输入，避免覆盖用户尚未保存的新密钥。
      authConfig.value = { ...authConfig.value, ...data, secretKey: authConfig.value.secretKey };
    }
    blockLoadState.auth = true;
    return true;
  } catch (err) {
    console.error('获取认证配置失败', err);
    blockLoadState.auth = false;
    return false;
  }
}

async function saveAuthConfig() {
  // 未成功加载的区块不允许保存，防止默认值覆盖服务端配置（G15-04）
  if (!blockLoadState.auth) {
    MessagePlugin.warning('认证配置加载失败，无法保存。请先点击"重新加载"');
    return;
  }
  try {
    await api.put('/admin/auth-config', authConfig.value);
    MessagePlugin.success('认证配置已保存');
    markClean();
  } catch (error: unknown) {
    MessagePlugin.error(getErrorMessage(error));
  }
}

/**
 * 邮箱验证码开关：由开→关属于放宽安全策略，需二次确认（G15-05）。
 * 确认后才真正写入表单值。
 */
function onEmailVerificationToggle(value: boolean) {
  const target = Boolean(value);
  const wasEnabled = authConfig.value.emailVerificationEnabled;
  if (target === wasEnabled) return;
  if (target === true) {
    // 由关→开：收紧策略，直接允许
    authConfig.value.emailVerificationEnabled = true;
    return;
  }
  // 由开→关：安全风险确认
  const confirmDialog = DialogPlugin.confirm({
    header: '关闭邮箱验证码',
    body: '关闭邮箱验证码将放宽安全策略：此后注册无需邮箱验证即可完成。'
      + '这可能降低账户安全性、增加垃圾账户注册风险。确定要关闭吗？',
    theme: 'warning',
    confirmBtn: '确定关闭',
    cancelBtn: '取消',
    onConfirm: () => {
      authConfig.value.emailVerificationEnabled = false;
      confirmDialog.destroy();
    },
    onClose: () => confirmDialog.destroy(),
  });
}

async function fetchSMTPConfig(): Promise<boolean> {
  try {
    const res = await api.get('/admin/smtp');
    const data = res.data.data;
    if (data) {
      // GET /admin/smtp 不返回 password，保留表单中已有的密码值，避免被响应覆盖为空导致无法二次保存
      smtpConfig.value = { ...smtpConfig.value, ...data, password: smtpConfig.value.password };
    }
    blockLoadState.smtp = true;
    return true;
  } catch (err) {
    console.error('获取SMTP配置失败', err);
    blockLoadState.smtp = false;
    return false;
  }
}

async function saveSMTPConfig() {
  // 未成功加载的区块不允许保存（G15-04）
  if (!blockLoadState.smtp) {
    MessagePlugin.warning('SMTP配置加载失败，无法保存。请先点击"重新加载"');
    return;
  }
  const { host, port, user, from } = smtpConfig.value;
  if (!String(host).trim() || !port || !String(user).trim() || !String(from).trim()) {
    MessagePlugin.warning('请填写SMTP服务器、端口、用户名和发件人');
    return;
  }
  try {
    await api.put('/admin/smtp', smtpConfig.value);
    MessagePlugin.success('SMTP配置已保存');
    markClean();
  } catch (error: unknown) {
    MessagePlugin.error(getErrorMessage(error));
  }
}

// —— 发送测试邮件 ——
const testEmailRecipient = ref('');
const sendingTestEmail = ref(false);
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

async function sendTestEmail() {
  if (sendingTestEmail.value) return;
  const recipient = testEmailRecipient.value.trim();
  if (!recipient) {
    MessagePlugin.warning('请输入收件人邮箱');
    return;
  }
  if (!EMAIL_RE.test(recipient)) {
    MessagePlugin.warning('收件人邮箱格式不正确');
    return;
  }
  sendingTestEmail.value = true;
  try {
    await api.post('/admin/smtp/test', { recipient });
    MessagePlugin.success('测试邮件已发送');
  } catch (error: unknown) {
    MessagePlugin.error(getErrorMessage(error));
  } finally {
    sendingTestEmail.value = false;
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
    blockLoadState.upload = true;
    return true;
  } catch (err) {
    console.error('获取上传配置失败', err);
    blockLoadState.upload = false;
    return false;
  }
}

async function saveUploadConfig() {
  // 未成功加载的区块不允许保存（G15-04）
  if (!blockLoadState.upload) {
    MessagePlugin.warning('上传配置加载失败，无法保存。请先点击"重新加载"');
    return;
  }
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
    markClean();
  } catch (error: unknown) {
    MessagePlugin.error(getErrorMessage(error));
  }
}

/**
 * 无缓存模式开关（G15-18）：由关→开会显著放大上游带宽/回源压力，需二次确认。
 * 确认后才真正写入表单值。
 */
function onNoCacheModeToggle(value: boolean) {
  const target = Boolean(value);
  const wasOn = cacheConfig.value.noCacheMode;
  if (target === wasOn) return;
  if (target === false) {
    // 关闭无缓存模式：恢复正常缓存，直接允许
    cacheConfig.value.noCacheMode = false;
    return;
  }
  // 开启无缓存模式：强调带宽影响
  const confirmDialog = DialogPlugin.confirm({
    header: '开启无缓存模式',
    body: '开启后所有文件下载将实时回源直通、不读写本地缓存，且 Range（断点/拖动播放）请求会退化为完整下载。'
      + '这将显著增大上游带宽压力与回源延迟。确定要开启吗？',
    theme: 'warning',
    confirmBtn: '仍要开启',
    cancelBtn: '取消',
    onConfirm: () => {
      cacheConfig.value.noCacheMode = true;
      confirmDialog.destroy();
    },
    onClose: () => confirmDialog.destroy(),
  });
}

async function fetchCacheConfig(): Promise<boolean> {
  try {
    const res = await api.get('/admin/cache-config');
    cacheConfig.value = res.data.data ?? cacheConfig.value;
    blockLoadState.cache = true;
    return true;
  } catch (err) {
    console.error('获取缓存配置失败', err);
    blockLoadState.cache = false;
    return false;
  }
}

async function saveCacheConfig() {
  // 未成功加载的区块不允许保存（G15-04）
  if (!blockLoadState.cache) {
    MessagePlugin.warning('缓存配置加载失败，无法保存。请先点击"重新加载"');
    return;
  }
  try {
    await api.put('/admin/cache-config', cacheConfig.value);
    MessagePlugin.success('缓存配置已保存');
    markClean();
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
    // 临时封禁：附带到期时间（G15-19），与 SecurityMonitor 封禁行为一致
    const payload: Record<string, unknown> = {
      ip,
      reason: banForm.reason,
      permanent: banForm.permanent,
    };
    if (!banForm.permanent) {
      payload.expiresAt = new Date(Date.now() + banForm.durationHours * 60 * 60 * 1000).toISOString();
    }
    await api.post('/admin/banned-ips', payload);
    MessagePlugin.success('IP已封禁');
    showBanDialog.value = false;
    banForm.ip = '';
    banForm.reason = '';
    banForm.permanent = true;
    banForm.durationHours = 6;
    fetchBannedIPs();
  } catch (error: unknown) {
    MessagePlugin.error(getErrorMessage(error));
  }
}

// isValidIP 由公共 util 提供（G15-28）：严格 IPv4/IPv6 校验，与 SecurityMonitor 复用同一实现

// 解封二次确认 + IPv6 编码（G15-20）：IPv6 地址含冒号，直接拼 URL 会解析异常，须 encodeURIComponent
function unbanIP(ip: string) {
  const confirmDialog = DialogPlugin.confirm({
    header: '解封 IP',
    body: `确定要解封 IP「${ip}」吗？解封后该 IP 将可再次访问系统。`,
    confirmBtn: '确认解封',
    cancelBtn: '取消',
    onConfirm: async () => {
      confirmDialog.destroy();
      try {
        await api.delete(`/admin/banned-ips/${encodeURIComponent(ip)}`);
        MessagePlugin.success('IP已解封');
        fetchBannedIPs();
      } catch (error: unknown) {
        MessagePlugin.error(getErrorMessage(error));
      }
    },
    onClose: () => confirmDialog.destroy(),
  });
}

onMounted(() => {
  Promise.allSettled([
    fetchSiteConfig(),
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
  }).finally(() => {
    // 初始加载完成：此后表单改动才算用户编辑，恢复脏检查（G15-17）
    suppressDirty.value = false;
  });
});
</script>

<style scoped>
.config-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 20px;
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
  gap: var(--space-2);
}

.smtp-test__row .t-button {
  flex-shrink: 0;
}

.smtp-test__hint {
  margin-top: var(--space-2);
  font-size: 12px;
  color: var(--text-secondary);
}

@media (max-width: 768px) {
  .config-grid.mobile-single-col {
    grid-template-columns: 1fr;
  }
}
</style>
