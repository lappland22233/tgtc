<template>
  <div class="share-view">
    <!-- 全局背景：暗色 + 微光斑，类似百度网盘分享页 -->
    <div class="bg-gradient" />

    <!-- 状态分支 -->
    <div class="share-container">
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
        <div class="state-icon">🚫</div>
        <h1>访问受限</h1>
        <p>{{ state.message }}</p>
        <p class="hint">密码错误次数过多，请稍后再试</p>
      </div>

      <!-- 分享不存在 / 已取消 / 已过期 -->
      <div v-else-if="state.kind === 'notFound'" class="state-card not-found-card">
        <div class="state-icon">🔍</div>
        <h1>分享不存在</h1>
        <p>{{ state.message || '此分享链接已失效或已被取消' }}</p>
        <p class="hint">请向分享者确认链接是否正确</p>
      </div>

      <!-- 文件分享 -->
      <FileShareCard
        v-else-if="state.kind === 'file'"
        :info="state.data"
        :token="token"
        :access-jwt="accessJwt ?? undefined"
      />

      <!-- 文件夹分享浏览（Phase 3：完整文件夹层级浏览） -->
      <FolderShareBrowser
        v-else-if="state.kind === 'folder'"
        :token="token"
        :access-jwt="accessJwt ?? undefined"
        :root-folder="state.data"
        :initial-contents="state.initialContents"
        :initial-breadcrumb="state.initialBreadcrumb"
      />
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted } from 'vue';
import { useRoute } from 'vue-router';
import PasswordPrompt from './PasswordPrompt.vue';
import FileShareCard from './FileShareCard.vue';
import FolderShareBrowser from './FolderShareBrowser.vue';

const route = useRoute();
const token = route.params.token as string;

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
const accessJwt = ref<string | null>(null);
const passwordError = ref('');
const verifying = ref(false);

/**
 * 拉取分享元数据。严格模式关键路径：
 * 后端在 link.password != null && !accessJwt 时
 * **不查询 target 表**，只返回 { requiresPassword: true }，
 * 此时前端无法从响应里推断文件/文件夹的任何信息。
 */
async function fetchInfo() {
  // 【P3】token 缺失时直接展示"分享不存在"，避免 encodeURIComponent(undefined)
  // 产生字面量 "undefined" 并发出无效请求
  if (!token) {
    state.value = { kind: 'notFound', message: '分享链接无效' };
    return;
  }
  try {
    // 后端 ShareController 从 query 参数 ?access=... 读取 accessJwt，
    // 不使用 Authorization header（避免与认证 JWT 混淆）
    const url = `/api/s/${encodeURIComponent(token)}` +
      (accessJwt.value ? `?access=${encodeURIComponent(accessJwt.value)}` : '');
    const res = await fetch(url);
    const data = await res.json();

    // 业务错误：分享不存在 / 过期 / 次数耗尽
    if (!res.ok || data.code !== 0) {
      const msg = data.message || '分享访问失败';
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
    const res = await fetch(`/api/s/${encodeURIComponent(token)}/verify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: pwd }),
    });
    const data = await res.json();
    if (!res.ok || data.code !== 0) {
      passwordError.value = data.message || '密码错误';
      return;
    }
    accessJwt.value = data.data.accessJwt;
    // 验证通过，重新拉取分享元数据
    await fetchInfo();
  } catch (err) {
    passwordError.value = err instanceof Error ? err.message : '网络错误';
  } finally {
    verifying.value = false;
  }
}

onMounted(fetchInfo);
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

/* 暗色背景 + 顶部微光（百度网盘风） */
.bg-gradient {
  position: fixed;
  inset: 0;
  background: linear-gradient(135deg, #0D1117 0%, #161B22 50%, #0D1117 100%);
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
  background: radial-gradient(ellipse, rgba(0, 82, 217, 0.15) 0%, transparent 70%);
  pointer-events: none;
}

.share-container {
  width: 100%;
  max-width: 560px;
  padding: 24px;
  position: relative;
  z-index: 1;
}

.state-card {
  background: #21262D;
  border: 1px solid #30363D;
  border-radius: 16px;
  padding: 48px 40px;
  text-align: center;
  box-shadow: 0 8px 32px rgba(0, 0, 0, 0.4);
  color: #E6EDF3;
  font-family: 'PingFang SC', 'Microsoft YaHei', sans-serif;
}

.state-icon {
  font-size: 64px;
  margin-bottom: 16px;
}

.state-card h1 {
  font-size: 22px;
  margin: 0 0 12px;
}

.state-card p {
  color: #8B949E;
  font-size: 14px;
  margin: 8px 0;
  line-height: 1.6;
}

.state-card .hint {
  color: #6E7681;
  font-size: 13px;
  margin-top: 16px;
}

.banned-card {
  border-color: rgba(248, 81, 73, 0.3);
}

.banned-card .state-icon {
  color: #F85149;
}

.not-found-card .state-icon {
  color: #6E7681;
}
</style>
