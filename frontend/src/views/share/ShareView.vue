<template>
  <div class="share-view">
    <!-- 全局背景：暗色 + 微光斑，类似百度网盘分享页 -->
    <div class="bg-gradient" />

    <!-- 状态分支 -->
    <div class="share-container" :class="{ 'share-container--wide': state.kind === 'folder' }">
      <!-- 加载中 -->
      <div v-if="state.kind === 'loading'" class="state-card">
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
          <svg width="64" height="64" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
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
          <svg width="64" height="64" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
            <circle cx="11" cy="11" r="8"/>
            <path d="m21 21-4.35-4.35"/>
          </svg>
        </div>
        <h1>分享不存在</h1>
        <p>{{ state.message || '此分享链接已失效或已被取消' }}</p>
        <p class="hint">请向分享者确认链接是否正确</p>
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
      />
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted, watch } from 'vue';
import { useRoute } from 'vue-router';
import { useMediaPlaybackStore } from '../../stores/mediaPlayback';
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
  | { kind: 'file'; data: FileInfo }
  | { kind: 'folder'; data: FolderInfo; initialContents: FolderContents; initialBreadcrumb: FolderSummary[] };

const state = ref<State>({ kind: 'loading' });
/** 该分享是否设置过密码（用于提示文案；凭据本身由后端 HttpOnly Cookie 保存） */
const isEncrypted = ref(false);
const passwordError = ref('');
const verifying = ref(false);

/**
 * 拉取分享元数据。严格模式关键路径：
 * 后端在 link.password != null 且未携带有效凭据时
 * **不查询 target 表**，只返回 { requiresPassword: true }，
 * 此时前端无法从响应里推断文件/文件夹的任何信息。
 * 密码验证通过后凭据由 HttpOnly Cookie 携带，请求同源自动附带。
 */
async function fetchInfo() {
  // 【P3】token 缺失时直接展示"分享不存在"，避免 encodeURIComponent(undefined)
  // 产生字面量 "undefined" 并发出无效请求
  if (!token) {
    state.value = { kind: 'notFound', message: '分享链接无效' };
    return;
  }
  try {
    // 凭据由 Cookie 携带，URL 中不出现 access JWT（C-02 修复）
    const res = await fetch(`/api/s/${encodeURIComponent(token.value)}`);
    const data = await res.json();

    // 业务错误：分享不存在 / 过期 / 次数耗尽
    if (!res.ok || data.code !== 0) {
      const msg = data.message || '分享访问失败';
      // H-02 修复：凭据失效 / 分享不可用（403/410/业务错误）时销毁该分享的媒体会话
      stopCurrentShareMedia();
      // 403 通常对应 IP 封禁
      if (res.status === 403) {
        state.value = { kind: 'banned', message: msg };
      } else {
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
    state.value = {
      kind: 'notFound',
      message: err instanceof Error ? err.message : '网络错误',
    };
  }
}

async function onPasswordSubmit(pwd: string) {
  passwordError.value = '';
  verifying.value = true;
  try {
    const res = await fetch(`/api/s/${encodeURIComponent(token.value)}/verify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: pwd }),
      // 需要接收后端设置的 HttpOnly Cookie
      credentials: 'same-origin',
    });
    const data = await res.json();
    if (!res.ok || data.code !== 0) {
      passwordError.value = data.message || '密码错误';
      return;
    }
    // 验证通过：凭据已由后端写入 HttpOnly Cookie，前端不再保存 accessJwt
    isEncrypted.value = true;
    // 重新拉取分享元数据（此时 Cookie 已就位）
    await fetchInfo();
  } catch (err) {
    passwordError.value = err instanceof Error ? err.message : '网络错误';
  } finally {
    verifying.value = false;
  }
}

/** H-02：停止当前分享上下文下的媒体会话（仅当会话来自分享且 token 匹配当前页面） */
function stopCurrentShareMedia() {
  const s = mediaStore.session;
  if (s?.context.type === 'share' && s.context.token === token.value) {
    mediaStore.requestStop();
  }
}

onMounted(fetchInfo);
watch(token, async (newToken, oldToken) => {
  // H-02 修复：分享 token 改变 = 离开原分享授权域，
  // 必须停止仍在播放的旧分享媒体会话并销毁授权状态，禁止跨分享继续播放。
  if (oldToken && oldToken !== newToken) {
    stopCurrentShareMedia();
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
  display: flex;
  align-items: center;
  justify-content: center;
  position: relative;
  overflow: hidden;
}

/* 背景 + 顶部微光 */
.bg-gradient {
  position: fixed;
  inset: 0;
  background: linear-gradient(135deg, var(--color-bg) 0%, var(--color-bg-surface) 50%, var(--color-bg) 100%);
  z-index: -1;
}

.bg-gradient::before {
  content: '';
  position: absolute;
  top: -200px;
  left: 50%;
  transform: translateX(-50%);
  width: 800px;
  height: 400px;
  background: radial-gradient(ellipse, var(--color-accent-soft) 0%, transparent 70%);
  pointer-events: none;
}

.share-container {
  width: 100%;
  max-width: 560px;
  padding: 24px;
  position: relative;
  z-index: 1;
}

/* 文件夹分享：更宽的容器 + 顶部对齐（内容较高，避免居中裁切） */
.share-container--wide {
  max-width: 960px;
}

.share-view:has(.share-container--wide) {
  align-items: flex-start;
}

.state-card {
  background: var(--color-bg-surface);
  border: 1px solid var(--border-default);
  border-radius: var(--radius-lg);
  padding: 48px 40px;
  text-align: center;
  box-shadow: var(--shadow-lg);
  color: var(--text-primary);
  font-family: var(--font-body);
}

.state-icon {
  display: flex;
  align-items: center;
  justify-content: center;
  margin-bottom: 16px;
}

.state-card h1 {
  font-size: 22px;
  margin: 0 0 12px;
}

.state-card p {
  color: var(--text-secondary);
  font-size: 14px;
  margin: 8px 0;
  line-height: 1.6;
}

.state-card .hint {
  color: var(--text-tertiary);
  font-size: 13px;
  margin-top: 16px;
}

.banned-card {
  border-color: color-mix(in srgb, var(--color-danger) 30%, transparent);
}

.banned-card .state-icon {
  color: var(--color-danger);
}

.not-found-card .state-icon {
  color: var(--text-tertiary);
}
</style>
