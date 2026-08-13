/**
 * 文本预览 composable
 *
 * 职责：
 * - 文本内容 fetch（同源 Cookie 自动携带）、流式读取与大小上限（2MB）限制。
 * - AbortController 取消与代次令牌防竞态（快速切换文件时旧请求结果不覆盖新状态）。
 *
 * 依赖注入：
 * - epoch：会话代次 ref（切换 / 重置时递增），本模块在发起加载时自增，
 *   宿主在 resetState 中递增，两者共用同一计数器使旧异步任务统一失效。
 */
import { computed, ref } from 'vue';
import type { Ref } from 'vue';

const TEXT_PREVIEW_LIMIT = 2 * 1024 * 1024;

export interface PreviewTextOptions {
  /** 会话代次：宿主 resetState 与文本加载共用，切换 / 重置时使旧请求失效 */
  epoch: Ref<number>;
}

export function usePreviewText(options: PreviewTextOptions) {
  const { epoch } = options;

  const textLoading = ref(false);
  const textContent = ref('');
  const textError = ref<string | null>(null);
  const textTooLarge = ref(false);
  /** 文本加载 AbortController（同一次会话内只有一个进行中的加载） */
  let textAbort: AbortController | null = null;

  /** 文本内容字符数（工具栏信息展示） */
  const textCharCount = computed(() => textContent.value.length);

  /**
   * 文本预览：同源 fetch（自动携带会话 Cookie）后流式读取。
   * Content-Length 超过 2MB 或流式累积超限时立即停止，提示下载查看。
   */
  async function loadText(url: string) {
    if (!url) {
      textError.value = '预览地址无效';
      return;
    }
    const token = ++epoch.value;
    textAbort?.abort();
    const ctrl = new AbortController();
    textAbort = ctrl;
    textLoading.value = true;
    try {
      const res = await fetch(url, { credentials: 'same-origin', signal: ctrl.signal });
      if (token !== epoch.value) return;
      if (!res.ok) {
        textError.value = res.status === 401 || res.status === 403
          ? `访问凭证已失效，请重新输入密码（HTTP ${res.status}）`
          : `文件加载失败（HTTP ${res.status}）`;
        return;
      }
      const contentLength = Number(res.headers.get('Content-Length') || 0);
      if (contentLength > TEXT_PREVIEW_LIMIT) {
        textTooLarge.value = true;
        return;
      }
      const body = res.body;
      if (!body) {
        const buf = await res.arrayBuffer();
        if (token !== epoch.value) return;
        if (buf.byteLength > TEXT_PREVIEW_LIMIT) {
          textTooLarge.value = true;
          return;
        }
        textContent.value = new TextDecoder('utf-8', { fatal: false }).decode(buf);
        return;
      }
      const reader = body.getReader();
      const decoder = new TextDecoder('utf-8', { fatal: false });
      let received = 0;
      let result = '';
      for (;;) {
        const { done, value } = await reader.read();
        if (token !== epoch.value) { await reader.cancel().catch(() => {}); return; }
        if (done) break;
        received += value.byteLength;
        if (received > TEXT_PREVIEW_LIMIT) {
          await reader.cancel().catch(() => {});
          textTooLarge.value = true;
          return;
        }
        result += decoder.decode(value, { stream: true });
      }
      result += decoder.decode();
      textContent.value = result;
    } catch {
      if (ctrl.signal.aborted || token !== epoch.value) return;
      textError.value = '网络错误，无法加载文件内容';
    } finally {
      if (textAbort === ctrl) textAbort = null;
      if (token === epoch.value) textLoading.value = false;
    }
  }

  /** 会话切换 / 重置：取消进行中的加载并清空文本状态 */
  function resetText() {
    textAbort?.abort();
    textAbort = null;
    textLoading.value = false;
    textContent.value = '';
    textError.value = null;
    textTooLarge.value = false;
  }

  /** 组件卸载：仅取消请求，不重置状态（避免卸载后的多余写入） */
  function abortText() {
    textAbort?.abort();
    textAbort = null;
  }

  return {
    textLoading,
    textContent,
    textError,
    textTooLarge,
    textCharCount,
    loadText,
    resetText,
    abortText,
  };
}
