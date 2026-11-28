<template>
  <div class="share-view">
    <header class="share-topbar">
      <WorkspaceBrand />
      <ThemeToggle variant="icon" />
    </header>

    <main class="share-container" :class="{ 'share-container--wide': state.kind === 'folder' }">
      <!-- 加载中 -->
      <div v-if="state.kind === 'loading'" class="state-card" role="status">
        <t-loading size="large" text="加载中..." />
      </div>

      <!-- 需要密码（严格模式：未通过前不显示任何 target 元数据） -->
      <PasswordPrompt
        v-else-if="state.kind === 'needPassword'"
        :error-message="passwordError"
        :loading="verifying"
        @submit="onPasswordSubmit"
      />

      <!-- IP 被封禁 -->
      <div v-else-if="state.kind === 'banned'" class="state-card banned-card">
        <div class="state-icon">
          <svg width="25" height="25" aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
            <circle cx="12" cy="12" r="10"/>
            <path d="m4.9 4.9 14.2 14.2"/>
          </svg>
        </div>
        <h1>访问受限</h1>
        <p>{{ state.message }}</p>
        <p class="hint">密码错误次数过多，请稍后再试</p>
      </div>

      <!-- 分享不存在 / 已取消 / 已过期 -->
      <div v-else-if="state.kind === 'notFound'" class="state-card not-found-card">
        <div class="state-icon">
          <svg width="25" height="25" aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
            <circle cx="11" cy="11" r="8"/>
            <path d="m21 21-4.35-4.35"/>
          </svg>
        </div>
        <h1>分享不存在</h1>
        <p>{{ state.message || '此分享链接已失效或已被取消' }}</p>
        <p class="hint">请向分享者确认链接是否正确</p>
      </div>

      <!-- 网络异常（区别于业务 notFound；弱网 / CDN 错误页 / 解析失败，可重试） -->
      <div v-else-if="state.kind === 'networkError'" class="state-card network-error-card">
        <div class="state-icon">
          <svg width="25" height="25" aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
            <path d="M1 9c5-4 17-4 22 0"/>
            <path d="M5 13c4-3 10-3 14 0"/>
            <path d="M9 17c2-1.5 4-1.5 6 0"/>
            <path d="M12 20h.01"/>
          </svg>
        </div>
        <h1>{{ state.title || '网络异常' }}</h1>
        <p>{{ state.message || '网络连接不稳定，请检查网络后重试' }}</p>
        <div class="retry-row">
          <t-button theme="primary" :loading="retrying" @click="onRetry">
            {{ retrying ? '重试中...' : '重新加载' }}
          </t-button>
        </div>
      </div>

      <!-- 文件分享 -->
      <FileShareCard
        v-else-if="state.kind === 'file'"
        :info="state.data"
        :token="token"
        :encrypted="isEncrypted"
      />

      <!-- 文件夹分享浏览（Phase 3：完整文件夹层级浏览） -->
      <FolderShareBrowser
        v-else-if="state.kind === 'folder'"
        :token="token"
        :encrypted="isEncrypted"
        :root-folder="state.data"
        :initial-contents="state.initialContents"
        :initial-breadcrumb="state.initialBreadcrumb"
        @credential-expired="onCredentialExpired"
      />
    </main>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted, watch } from 'vue';
import { useRoute } from 'vue-router';
import WorkspaceBrand from '@/components/WorkspaceBrand.vue';
import ThemeToggle from '@/components/ThemeToggle.vue';
import { useMediaPlaybackStore } from '../../stores/mediaPlayback';
import { withXsrfHeader } from '../../utils/xsrf';
import PasswordPrompt from './PasswordPrompt.vue';
import FileShareCard from './FileShareCard.vue';
import FolderShareBrowser from './FolderShareBrowser.vue';

const route = useRoute();
const token = computed(() => String(route.params.token || ''));
const mediaStore = useMediaPlaybackStore();

interface FileInfo {
  id: string;
  name: string;
  size: number;
  mimeType: string;
  createdAt: string;
  expiresAt?: string | null;
}
interface FolderInfo {
  id: string;
  name: string;
  createdAt: string;
  expiresAt?: string | null;
}
interface FolderSummary {
  id: string;
  name: string;
}
interface FileSummary {
  id: string;
  name: string;
  size: number;
  mimeType: string;
  createdAt: string;
  downloadUrl: string;
  /** 文件状态（ready/processing/error），用于过滤可预览文件 */
  status?: string;
}
interface FolderContents {
  subfolders: FolderSummary[];
  files: FileSummary[];
}

type State =
  | { kind: 'loading' }
  | { kind: 'needPassword' }
  | { kind: 'banned'; message: string }
  | { kind: 'notFound'; message?: string }
  | { kind: 'networkError'; title?: string; message?: string }
  | { kind: 'file'; data: FileInfo }
  | { kind: 'folder'; data: FolderInfo; initialContents: FolderContents; initialBreadcrumb: FolderSummary[] };

const state = ref<State>({ kind: 'loading' });
/** 该分享是否设置过密码（用于提示文案；凭据本身由后端 HttpOnly Cookie 保存） */
const isEncrypted = ref(false);
const passwordError = ref('');
const verifying = ref(false);
/** 网络异常卡片的重试进行中状态（防重复点击） */
const retrying = ref(false);
let requestGeneration = 0;
let activeRequest: AbortController | null = null;
let verifyGeneration = 0;

function isCurrent(generation: number): boolean {
  return generation === requestGeneration;
}

/**
 * 拉取分享元数据。严格模式关键路径：
 * 后端在 link.password != null 且未携带有效凭据时
 * **不查询 target 表**，只返回 { requiresPassword: true }，
 * 此时前端无法从响应里推断文件/文件夹的任何信息。
 * 密码验证通过后凭据由 HttpOnly Cookie 携带，请求同源自动附带。
 */
async function fetchInfo() {
  const generation = ++requestGeneration;
  activeRequest?.abort();
  activeRequest = new AbortController();
  const { signal } = activeRequest;
  // 【P3】token 缺失时直接展示"分享不存在"，避免 encodeURIComponent(undefined)
  // 产生字面量 "undefined" 并发出无效请求
  if (!token.value) {
    state.value = { kind: 'notFound', message: '分享链接无效' };
    return;
  }
  try {
    // 凭据由 Cookie 携带，URL 中不出现 access JWT（C-02 修复）
    const res = await fetch(`/api/s/${encodeURIComponent(token.value)}`, { signal });
    let data: any;
    try {
      // 弱网 / CDN 返回非 JSON 错误页（502 HTML）时 res.json() 会抛 SyntaxError，
      // 归入网络异常分支而非业务 notFound（G13-02）。
      data = await res.json();
    } catch {
      if (!isCurrent(generation)) return;
      state.value = { kind: 'networkError', message: '服务响应异常，请稍后重试' };
      return;
    }
    if (!isCurrent(generation)) return;

    // 业务错误：分享不存在 / 过期 / 次数耗尽 / 限流 / 临时服务故障
    if (!res.ok || data.code !== 0) {
      const msg = data.message || '分享访问失败';
      // H-02 修复：凭据失效 / 分享不可用（403/410/业务错误）时销毁该分享的媒体会话
      stopCurrentShareMedia();
      // 403 通常对应 IP 封禁
      if (res.status === 403) {
        state.value = { kind: 'banned', message: msg };
      } else if (res.status === 429 || res.status >= 500) {
        // 限流 / 临时服务故障 ≠ 链接失效：进入可恢复分支（保留重试入口），
        // 避免把“稍后可恢复”的故障误报为“分享不存在”误导用户去找分享者。
        state.value = {
          kind: 'networkError',
          title: res.status === 429 ? '访问过于频繁' : '服务暂时不可用',
          message: res.status === 429
            ? (msg || '请求过于频繁，请稍后再试')
            : (msg || '服务暂时不可用，请稍后重试'),
        };
      } else {
        // 404/410 及其余业务错误：分享确实不存在/已失效
        state.value = { kind: 'notFound', message: msg };
      }
      return;
    }

    const payload = data.data;
    // 严格模式：需要密码 → 只切换状态，不泄露任何 target 信息
    if (payload.requiresPassword) {
      // H-02 修复：Cookie 过期 / 凭据失效返回 requiresPassword 时销毁旧媒体会话，
      // 避免残留的分享媒体在凭据失效后继续播放。
      stopCurrentShareMedia();
      state.value = { kind: 'needPassword' };
      return;
    }
    // 文件分享：拿到 fileInfo
    if (payload.targetType === 'file' && payload.fileInfo) {
      state.value = { kind: 'file', data: payload.fileInfo as FileInfo };
      return;
    }
    // 文件夹分享：拿到 folderInfo + 初始根级内容 + 面包屑
    if (payload.targetType === 'folder' && payload.folderInfo) {
      state.value = {
        kind: 'folder',
        data: payload.folderInfo as FolderInfo,
        initialContents: (payload.contents || { subfolders: [], files: [] }) as FolderContents,
        initialBreadcrumb: (payload.breadcrumb || [{ id: payload.folderInfo.id, name: payload.folderInfo.name }]) as FolderSummary[],
      };
      return;
    }
    // 异常响应
    state.value = { kind: 'notFound', message: '分享响应格式异常' };
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') return;
    if (!isCurrent(generation)) return;
    // 断网 / 请求本身失败（fetch reject）→ 网络异常而非"分享不存在"
    state.value = {
      kind: 'networkError',
      message: err instanceof Error ? err.message : '网络错误',
    };
  }
}

/** 网络异常卡片重试：重新拉取分享元数据 */
async function onRetry() {
  if (retrying.value) return;
  retrying.value = true;
  try {
    await fetchInfo();
  } finally {
    retrying.value = false;
  }
}

/**
 * 文件夹浏览凭据过期（G13-01）：重新拉取分享元数据。
 * 后端会在 Cookie 失效时返回 requiresPassword，fetchInfo 自动切回密码输入状态。
 */
function onCredentialExpired() {
  // 销毁该分享的媒体会话（凭据失效后不应继续播放）
  stopCurrentShareMedia();
  void fetchInfo();
}

async function onPasswordSubmit(pwd: string) {
  const generation = requestGeneration;
  const verifyId = ++verifyGeneration;
  passwordError.value = '';
  verifying.value = true;
  // B-22：验证请求必须用独立 controller。复用 activeRequest.signal 时，验证期间
  // 若 fetchInfo 被重新触发（凭据过期 / 重试）会 abort 掉正在进行的验证请求。
  const verifyController = new AbortController();
  try {
    const res = await fetch(`/api/s/${encodeURIComponent(token.value)}/verify`, {
      signal: verifyController.signal,
      method: 'POST',
      // CSRF 双重提交：已登录访客（浏览器持有 access_token Cookie）必须携带
      // 与 XSRF-TOKEN Cookie 一致的 X-XSRF-TOKEN 头，否则被全局 CsrfGuard 拒绝（403）。
      // 匿名访客没有该 Cookie，withXsrfHeader 不会注入头（后端放行）。
      headers: withXsrfHeader({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ password: pwd }),
      // 需要接收后端设置的 HttpOnly Cookie
      credentials: 'same-origin',
    });
    const data = await res.json();
    if (generation !== requestGeneration || verifyId !== verifyGeneration) return;
    if (!res.ok || data.code !== 0) {
      // 403 = IP 封禁（密码错误次数过多）：切到 banned 状态，而非仅显示密码错误
      if (res.status === 403) {
        stopCurrentShareMedia();
        state.value = { kind: 'banned', message: data.message || '访问受限' };
        return;
      }
      passwordError.value = data.message || '密码错误';
      return;
    }
    // 验证通过：凭据已由后端写入 HttpOnly Cookie，前端不再保存 accessJwt
    isEncrypted.value = true;
    // 重新拉取分享元数据（此时 Cookie 已就位）
    await fetchInfo();
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') return;
    if (generation !== requestGeneration || verifyId !== verifyGeneration) return;
    passwordError.value = err instanceof Error ? err.message : '网络错误';
  } finally {
    // 只按 verifyId 守卫复位：requestGeneration 变化（fetchInfo 重跑）不得让
    // 提交按钮永久停在 loading 态。
    if (verifyId === verifyGeneration) verifying.value = false;
  }
}

/** H-02：停止当前分享上下文下的媒体会话（仅当会话来自分享且 token 匹配当前页面） */
function stopCurrentShareMedia(shareToken = token.value) {
  const s = mediaStore.session;
  if (s?.context.type === 'share' && s.context.token === shareToken) {
    mediaStore.requestStop();
  }
}

onMounted(fetchInfo);
onUnmounted(() => {
  requestGeneration++;
  verifyGeneration++;
  activeRequest?.abort();
});
watch(token, async (newToken, oldToken) => {
  // H-02 修复：分享 token 改变 = 离开原分享授权域，
  // 必须停止仍在播放的旧分享媒体会话并销毁授权状态，禁止跨分享继续播放。
  if (oldToken && oldToken !== newToken) {
    stopCurrentShareMedia(oldToken);
  }
  isEncrypted.value = false;
  passwordError.value = '';
  verifying.value = false;
  state.value = { kind: 'loading' };
  await fetchInfo();
});
</script>

<style scoped>
.share-view {
  min-height: 100vh;
  min-height: 100dvh;
  background: var(--workspace-canvas);
  color: var(--workspace-text);
}

.share-topbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-3);
  min-height: var(--workspace-header-height);
  padding-inline: clamp(12px, 4vw, 32px);
  border-bottom: 1px solid var(--workspace-border);
  background: var(--workspace-surface);
}

.share-container {
  width: min(100%, 760px);
  margin-inline: auto;
  padding: clamp(16px, 4vw, 40px) clamp(12px, 4vw, 32px) 48px;
}

.share-container--wide { width: min(100%, 1080px); }

.state-card {
  max-width: 460px;
  margin-inline: auto;
  padding: clamp(16px, 5vw, 32px);
  border: 1px solid var(--workspace-border);
  border-radius: 12px;
  background: var(--workspace-surface);
  overflow-wrap: anywhere;
}

.state-icon {
  display: inline-grid;
  place-items: center;
  width: 44px;
  height: 44px;
  margin-bottom: 12px;
  border-radius: 9px;
  background: var(--workspace-canvas);
  color: var(--workspace-muted);
}

.state-card h1 {
  margin: 0 0 8px;
  font-size: clamp(23px, 4vw, 30px);
  line-height: 1.25;
}

.state-card p {
  margin: 0;
  color: var(--workspace-muted);
}

.state-card .hint { margin-top: 8px; }
.banned-card .state-icon { color: var(--color-danger); }
.network-error-card .state-icon { color: var(--color-warning); }

.retry-row { margin-top: 16px; }
.retry-row :deep(.t-button) {
  min-height: 44px;
  border-radius: 8px;
}
</style>
