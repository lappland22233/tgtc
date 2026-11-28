<template>
  <div class="system-config-page">
    <div class="page-header flex flex-wrap items-center justify-between gap-3">
      <div>
        <h1>系统配置</h1>
        <p>配置站点信息、认证安全、上传缓存、下载调度、Telegram Bot 与 IP 封禁</p>
      </div>
      <div v-if="dirty" class="cfg-dirty-badge" role="status">
        有未保存修改
      </div>
    </div>

    <nav class="cfg-outline" aria-label="系统配置导航">
      <a href="#config-site" class="cfg-outline-link">网站标题</a>
      <a href="#config-auth" class="cfg-outline-link">认证与邮件</a>
      <a href="#config-upload" class="cfg-outline-link">文件上传</a>
      <a href="#config-cache" class="cfg-outline-link">文件缓存</a>
      <a href="#config-download" class="cfg-outline-link">下载调度</a>
      <a href="#config-bot" class="cfg-outline-link">Bot 设置</a>
      <a href="#config-ipban" class="cfg-outline-link">IP 封禁</a>
    </nav>

    <ConfigSiteSection
      v-model:site-config="siteConfig"
      :loaded="blockLoadState.site"
      @save="saveSiteConfig"
      @reload="fetchSiteConfig"
    />

    <ConfigAuthSmtpSection
      v-model:auth-config="authConfig"
      v-model:smtp-config="smtpConfig"
      v-model:test-email-recipient="testEmailRecipient"
      :auth-loaded="blockLoadState.auth"
      :smtp-loaded="blockLoadState.smtp"
      :sending-test-email="sendingTestEmail"
      @toggle-email-verification="onEmailVerificationToggle"
      @save-auth="saveAuthConfig"
      @reload-auth="fetchAuthConfig"
      @save-smtp="saveSMTPConfig"
      @reload-smtp="fetchSMTPConfig"
      @send-test-email="sendTestEmail"
    />

    <ConfigUploadSection
      v-model:upload-config="uploadConfig"
      v-model:custom-extension="customExtension"
      :loaded="blockLoadState.upload"
      :preset-extensions="presetExtensions"
      :selected-extensions="selectedExtensions"
      @toggle-extension="toggleExtension"
      @remove-extension="removeExtension"
      @add-custom-extension="addCustomExtension"
      @save="saveUploadConfig"
      @reload="fetchUploadConfig"
    />

    <ConfigCacheDownloadSection
      v-model:cache-config="cacheConfig"
      v-model:download-config="downloadConfig"
      :cache-loaded="blockLoadState.cache"
      :download-loaded="blockLoadState.download"
      :download-runtime="downloadRuntime"
      :replica-target="replicaTarget"
      :queue-policy-options="queuePolicyOptions"
      :queue-policy-text="queuePolicyText"
      :format-bytes="formatBytes"
      @toggle-no-cache="onNoCacheModeToggle"
      @save-cache="saveCacheConfig"
      @reload-cache="fetchCacheConfig"
      @save-download="saveDownloadConfig"
      @refresh-runtime="fetchDownloadRuntime"
      @reload-download="fetchDownloadConfig"
    />

    <ConfigBotSection
      v-model:bot-config="botConfig"
      :loaded="blockLoadState.bot"
      :effective-domain="botEffectiveDomain"
      :crypto-available="botCryptoAvailable"
      :detecting-domain="detectingDomain"
      :saving="savingBotConfig"
      @detect-domain="detectBotDomain"
      @save="saveBotConfig"
      @reload="fetchBotConfig"
    />

    <ConfigIpBanSection
      v-model:show-ban-dialog="showBanDialog"
      v-model:ban-form="banForm"
      :banned-i-ps="bannedIPs"
      :ip-columns="ipColumns"
      :format-date="formatDate"
      @ban="banIP"
      @unban="unbanIP"
    />
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted, onBeforeUnmount, watch } from 'vue';
import { onBeforeRouteLeave } from 'vue-router';
import { DialogPlugin } from 'tdesign-vue-next/es/dialog';
import MessagePlugin from '@/utils/message';
import { api } from '../../stores/auth';
import { usePublicConfigStore } from '../../stores/public-config';
import { useUploadConfigStore } from '../../stores/upload-config';
import { getErrorMessage } from '../../utils/error';
import { formatDate } from '../../utils/format';
import { isValidIP } from '../../utils/ip';
// 副本有效目标（只读观测）：与「Telegram 账号池」页共用同一份解析结果
import { fetchReplicationAudit } from '../../api/telegram-accounts';
import ConfigSiteSection from '../../components/admin/config/ConfigSiteSection.vue';
import ConfigAuthSmtpSection from '../../components/admin/config/ConfigAuthSmtpSection.vue';
import ConfigUploadSection from '../../components/admin/config/ConfigUploadSection.vue';
import ConfigCacheDownloadSection from '../../components/admin/config/ConfigCacheDownloadSection.vue';
import ConfigBotSection from '../../components/admin/config/ConfigBotSection.vue';
import ConfigIpBanSection from '../../components/admin/config/ConfigIpBanSection.vue';
import type { DownloadRuntime, PresetExtensionItem } from '../../components/admin/config/types';

const publicConfigStore = usePublicConfigStore();
const uploadConfigStore = useUploadConfigStore();

// 各配置区块加载状态：加载失败时禁用对应保存按钮并阻止提交，防止用默认值覆盖服务端真实配置（G15-04）
const blockLoadState = ref({
  site: false as boolean,
  auth: false as boolean,
  smtp: false as boolean,
  upload: false as boolean,
  cache: false as boolean,
  download: false as boolean,
  bot: false as boolean,
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

// 下载资源调度（FILE_DOWNLOAD_*）：默认值需与后端 DOWNLOAD_CONFIG_DEFAULTS 保持一致
const downloadConfig = ref({
  maxReservedGB: 0,
  maxConcurrentUpstreams: 8,
  queueCapacity: 128,
  queueTimeoutSeconds: 1800,
  spoolGraceSeconds: 120,
  directWindowMB: 1,
  directWaitSeconds: 60,
  taskRetentionSeconds: 900,
  // 上游等待项选择策略：strict_fifo=严格 FIFO（回退）；bounded_fit=适配优先
  upstreamQueuePolicy: 'strict_fifo' as 'strict_fifo' | 'bounded_fit',
  // 全局权重预算自动扩缩容开关（按有效 Bot 数）
  autoCapacityEnabled: true,
  // 下载优先使用 Premium 用户账号（MTProto）回源；关闭即回到纯 Bot 链路
  preferUserAccount: false,
  // user 账号并发上限与瞬时失败冷却（需与后端 DOWNLOAD_CONFIG_DEFAULTS 一致）
  userStreamMaxConcurrency: 4,
  userFailureCooldownSeconds: 10,
});

const downloadRuntime = ref<DownloadRuntime | null>(null);

/** 副本有效目标（只读展示；详见「Telegram 账号池」页的副本扩散策略卡） */
const replicaTarget = ref<{
  configured: number;
  eligibleCount: number;
  effectiveTarget: number;
} | null>(null);

/** 队列策略文案（未知值按严格 FIFO 展示，避免误导） */
function queuePolicyText(policy: DownloadRuntime['upstreamQueuePolicy']): string {
  return policy === 'bounded_fit' ? '适配优先（bounded_fit）' : '严格 FIFO';
}

/** 队列策略下拉选项（与后端 UPSTREAM_QUEUE_POLICIES 对齐） */
const queuePolicyOptions = [
  { value: 'strict_fifo', label: '严格 FIFO（回退模式）' },
  { value: 'bounded_fit', label: '适配优先（bounded_fit）' },
];

/** 字节数展示（运行状态卡使用） */
function formatBytes(value: number | undefined): string {
  if (value === undefined || value === null || value < 0) return '未知';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let size = value;
  let unit = 0;
  while (size >= 1024 && unit < units.length - 1) {
    size /= 1024;
    unit += 1;
  }
  return `${size >= 10 || unit === 0 ? Math.round(size) : size.toFixed(1)} ${units[unit]}`;
}

// Telegram Bot 设置（D14 + D16）：统一走 /admin/bot-config 热更新
const botConfig = ref({
  linkTtlHours: 4,
  dailyLimit: 5,
  quotaTimezone: 'Asia/Shanghai',
  linkDomainMode: 'auto' as 'auto' | 'manual',
  linkDomain: '',
  storageMode: 'telegram' as 'telegram' | 'gdrive',
  telegramStorageChatConfigured: true,
});
const botEffectiveDomain = ref('');
const botCryptoAvailable = ref(false);
const detectingDomain = ref(false);
const savingBotConfig = ref(false);

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
watch([authConfig, smtpConfig, uploadConfig, cacheConfig, downloadConfig, botConfig], () => {
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
const presetExtensions: PresetExtensionItem[] = [
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
const banForm = ref({ ip: '', reason: '', permanent: true, durationHours: 6 });

const ipColumns = [
  { colKey: 'ip', title: 'IP地址', width: '150' },
  { colKey: 'reason', title: '原因', width: '200' },
  { colKey: 'isPermanent', title: '类型', width: '100' },
  { colKey: 'createdAt', title: '封禁时间', width: '150' },
  { colKey: 'expiresAt', title: '到期时间', width: '150' },
  { colKey: 'operations', title: '操作', width: '100' },
];

async function fetchSiteConfig(): Promise<boolean> {
  // 经共享 store 读取（与启动初始化合并并发请求）；失败时 store 保留最后成功值，
  // 本页按加载失败禁用保存，防止用默认值覆盖服务端配置。
  const ok = await publicConfigStore.fetchSiteTitle();
  if (ok) {
    siteConfig.value.title = publicConfigStore.siteTitle;
    blockLoadState.value.site = true;
  } else {
    blockLoadState.value.site = false;
  }
  return ok;
}

async function saveSiteConfig() {
  if (!blockLoadState.value.site) {
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
    // 提交到共享 store：侧栏大标题与浏览器标签立即同步，无需刷新或重拉
    publicConfigStore.setSiteTitle(title);
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
    blockLoadState.value.auth = true;
    return true;
  } catch (err) {
    console.error('获取认证配置失败', err);
    blockLoadState.value.auth = false;
    return false;
  }
}

async function saveAuthConfig() {
  // 未成功加载的区块不允许保存，防止默认值覆盖服务端配置（G15-04）
  if (!blockLoadState.value.auth) {
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
    blockLoadState.value.smtp = true;
    return true;
  } catch (err) {
    console.error('获取SMTP配置失败', err);
    blockLoadState.value.smtp = false;
    return false;
  }
}

async function saveSMTPConfig() {
  // 未成功加载的区块不允许保存（G15-04）
  if (!blockLoadState.value.smtp) {
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
    blockLoadState.value.upload = true;
    return true;
  } catch (err) {
    console.error('获取上传配置失败', err);
    blockLoadState.value.upload = false;
    return false;
  }
}

async function saveUploadConfig() {
  // 未成功加载的区块不允许保存（G15-04）
  if (!blockLoadState.value.upload) {
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
    uploadConfigStore.setConfig({
      maxFileSize: uploadConfig.value.maxFileSizeMB * 1024 * 1024,
      fileTypeMode: uploadConfig.value.fileTypeMode,
      fileTypeFilter: selectedExtensions.value,
      // /admin/upload-config 不控制运行时小盘模式；保留最近一次认证上传配置读取的严格策略。
      strictSerialUpload: uploadConfigStore.config.strictSerialUpload,
    });
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
    body: '开启后不再发布正式缓存：下载仍需写入临时中转文件（用于同一文件的并发下载复用），'
      + 'Range（断点/拖动播放）请求保持 206，但冷文件仍会完整回源，因此会显著增大上游带宽压力与回源延迟。'
      + '确定要开启吗？',
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
    blockLoadState.value.cache = true;
    return true;
  } catch (err) {
    console.error('获取缓存配置失败', err);
    blockLoadState.value.cache = false;
    return false;
  }
}

async function saveCacheConfig() {
  // 未成功加载的区块不允许保存（G15-04）
  if (!blockLoadState.value.cache) {
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

// —— 下载资源调度 ——

async function fetchDownloadConfig(): Promise<boolean> {
  try {
    const res = await api.get('/admin/download-config');
    downloadConfig.value = res.data.data ?? downloadConfig.value;
    blockLoadState.value.download = true;
    return true;
  } catch (err) {
    console.error('获取下载调度配置失败', err);
    blockLoadState.value.download = false;
    return false;
  }
}

async function saveDownloadConfig() {
  // 未成功加载的区块不允许保存（G15-04）
  if (!blockLoadState.value.download) {
    MessagePlugin.warning('下载调度配置加载失败，无法保存。请先点击"重新加载"');
    return;
  }
  try {
    await api.put('/admin/download-config', downloadConfig.value);
    MessagePlugin.success('下载调度配置已保存（对后续下载任务生效，不中断进行中的下载）');
    markClean();
    await fetchDownloadRuntime();
  } catch (error: unknown) {
    MessagePlugin.error(getErrorMessage(error));
  }
}

/** 运行状态快照：磁盘余量、预约量、队列长度、权重预算与进程内存 */
async function fetchDownloadRuntime(): Promise<void> {
  try {
    const res = await api.get('/admin/download-runtime');
    downloadRuntime.value = res.data.data ?? null;
  } catch (err) {
    console.error('获取下载运行状态失败', err);
    downloadRuntime.value = null;
  }
}

/** 副本有效目标（只读观测；失败不提示，避免与账号池页面重复报错） */
async function fetchReplicaTarget(): Promise<void> {
  try {
    const report = await fetchReplicationAudit();
    replicaTarget.value = report?.target ?? null;
  } catch {
    replicaTarget.value = null;
  }
}

// —— Telegram Bot 设置 ——

async function fetchBotConfig(): Promise<boolean> {
  try {
    const res = await api.get('/admin/bot-config');
    const data = res.data.data;
    if (data?.config) {
      botConfig.value = { ...botConfig.value, ...data.config };
    }
    botEffectiveDomain.value = data?.effectiveDomain || '';
    botCryptoAvailable.value = Boolean(data?.cryptoAvailable);
    blockLoadState.value.bot = true;
    return true;
  } catch (err) {
    console.error('获取 Bot 配置失败', err);
    blockLoadState.value.bot = false;
    return false;
  }
}

/** 「自动获取」：调探测端点回填候选域名（不自动保存，供管理员确认） */
async function detectBotDomain() {
  if (detectingDomain.value) return;
  detectingDomain.value = true;
  try {
    const res = await api.get('/admin/bot-config/detected-domain');
    const detected = res.data.data?.detectedDomain;
    if (detected) {
      botConfig.value.linkDomain = detected;
      botConfig.value.linkDomainMode = 'manual';
      MessagePlugin.success('已回填检测到的域名，请确认后保存');
    } else {
      MessagePlugin.warning('未能从可信来源获取域名（APP_URL 未配置且无可信代理头），请手动填写');
    }
  } catch (error: unknown) {
    MessagePlugin.error(getErrorMessage(error));
  } finally {
    detectingDomain.value = false;
  }
}

async function saveBotConfig() {
  if (savingBotConfig.value) return;
  if (!blockLoadState.value.bot) {
    MessagePlugin.warning('Bot 配置加载失败，无法保存。请先点击"重新加载"');
    return;
  }
  if (botConfig.value.storageMode === 'telegram' && !botConfig.value.telegramStorageChatConfigured) {
    MessagePlugin.warning('未配置 Telegram 存储群组（TELEGRAM_CHAT_ID 或账号池存储群），无法开启原生 Telegram 存储模式，请使用纯 Google 存储模式');
    return;
  }
  const ttl = Number(botConfig.value.linkTtlHours);
  if (!Number.isInteger(ttl) || ttl < 1 || ttl > 720) {
    MessagePlugin.warning('直链有效期必须为 1–720 的整数（小时）');
    return;
  }
  const limit = Number(botConfig.value.dailyLimit);
  if (!Number.isInteger(limit) || limit < 1 || limit > 100000) {
    MessagePlugin.warning('每日额度必须为 1–100000 的整数');
    return;
  }
  const timezone = botConfig.value.quotaTimezone.trim();
  if (!timezone) {
    MessagePlugin.warning('切日时区不能为空');
    return;
  }
  const domain = botConfig.value.linkDomain.trim();
  if (botConfig.value.linkDomainMode === 'manual') {
    if (!domain) {
      MessagePlugin.warning('手动模式下必须填写站点域名');
      return;
    }
    if (!/^https?:\/\/[^\s/]+$/i.test(domain)) {
      MessagePlugin.warning('站点域名须为 http(s)://host[:port] 形式，且不含路径');
      return;
    }
  }
  savingBotConfig.value = true;
  try {
    await api.put('/admin/bot-config', {
      linkTtlHours: ttl,
      dailyLimit: limit,
      quotaTimezone: timezone,
      linkDomainMode: botConfig.value.linkDomainMode,
      linkDomain: domain,
      storageMode: botConfig.value.storageMode,
    });
    await fetchBotConfig();
    MessagePlugin.success('Bot 配置已保存');
    markClean();
  } catch (error: unknown) {
    MessagePlugin.error(getErrorMessage(error));
  } finally {
    savingBotConfig.value = false;
  }
}

async function fetchBannedIPs(): Promise<boolean> {
  try {
    const res = await api.get('/admin/banned-ips');
    const raw = res.data.data;
    bannedIPs.value = Array.isArray(raw) ? raw : [];
    return true;
  } catch (err) {
    console.error('获取封禁IP列表失败', err);
    return false;
  }
}

async function banIP() {
  const ip = banForm.value.ip.trim();
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
      reason: banForm.value.reason,
      permanent: banForm.value.permanent,
    };
    if (!banForm.value.permanent) {
      payload.expiresAt = new Date(Date.now() + banForm.value.durationHours * 60 * 60 * 1000).toISOString();
    }
    await api.post('/admin/banned-ips', payload);
    MessagePlugin.success('IP已封禁');
    showBanDialog.value = false;
    banForm.value.ip = '';
    banForm.value.reason = '';
    banForm.value.permanent = true;
    banForm.value.durationHours = 6;
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
    fetchDownloadConfig(),
    fetchBotConfig(),
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
  // 下载运行状态与副本目标为只读观测：加载失败不影响保存，单独请求即可
  void fetchDownloadRuntime();
  void fetchReplicaTarget();
});
</script>

<style scoped>
.cfg-dirty-badge {
  display: inline-flex;
  align-items: center;
  padding: 4px 10px;
  border-radius: 999px;
  border: 1px solid color-mix(in srgb, var(--color-warning) 40%, transparent);
  background: var(--color-warning-soft);
  color: var(--color-warning);
  font-size: 12px;
  font-weight: 500;
}

.cfg-outline {
  display: flex;
  flex-wrap: nowrap;
  gap: 6px;
  overflow-x: auto;
  scrollbar-width: thin;
  padding: 8px 10px;
  margin-bottom: 16px;
  background: var(--color-bg-surface);
  border: 1px solid var(--border-default);
  border-radius: var(--radius-md);
}

.cfg-outline-link {
  flex: none;
  padding: 6px 10px;
  border-radius: var(--radius-sm);
  font-size: 13px;
  font-weight: 500;
  color: var(--text-secondary);
  text-decoration: none;
  white-space: nowrap;
  transition: background-color var(--duration-fast) var(--ease-out-expo), color var(--duration-fast) var(--ease-out-expo);
}

.cfg-outline-link:hover {
  background: var(--color-bg-hover);
  color: var(--seed-primary);
}

.system-config-page :deep(.t-form__controls-content) {
  min-inline-size: 0;
  flex-wrap: wrap;
  overflow-wrap: anywhere;
}

@media (min-width: 769px) {
  .cfg-outline {
    position: sticky;
    top: 12px;
    z-index: 5;
    flex-wrap: wrap;
  }
}
</style>
