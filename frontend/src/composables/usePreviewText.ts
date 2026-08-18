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

/** 需要降级为 GBK/GB18030 解码的 MIME 字符集集合 */
const GBK_CHARSETS = new Set(['gbk', 'gb2312', 'gb18030', 'gb_2312-80', 'cp936']);
/** 是否支持 GBK 解码（依赖 TextDecoder 对 'gbk'/'gb18030' 的原生支持；无则回退 UTF-8） */
const GBK_DECODER_SUPPORTED = (() => {
  try {
    const d = new TextDecoder('gb18030');
    return d.encoding !== '';
  } catch {
    return false;
  }
})();

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
   * 从响应 Content-Type 解析 charset，返回可用的 TextDecoder 标签；无有效编码时返回 null。
   * 优先信任响应头声明的 charset；声明为 GBK 系列且浏览器支持时选用对应解码器。
   */
  function resolveDecoderLabel(contentType: string | null): string | null {
    if (!contentType) return null;
    const m = /charset\s*=\s*["']?([^;"'\s]+)/i.exec(contentType);
    const charset = m?.[1]?.trim().toLowerCase();
    if (!charset) return null;
    if (charset === 'utf-8' || charset === 'utf8') return 'utf-8';
    if (GBK_CHARSETS.has(charset)) return GBK_DECODER_SUPPORTED ? 'gb18030' : 'utf-8';
    // 其他未知 charset（如 iso-8859-1）不强行解码，回退 utf-8
    return 'utf-8';
  }

  /**
   * 轻量编码探测：UTF-8 严格校验失败且存在连续 GBK 双字节模式时推断为 GBK。
   * 仅在响应头未声明 charset 时使用，避免误判。
   */
  function detectEncoding(bytes: Uint8Array): 'utf-8' | 'gb18030' {
    if (!GBK_DECODER_SUPPORTED) return 'utf-8';
    const len = Math.min(bytes.length, 4096);
    // 先尝试严格 UTF-8 解码；无替换字符即视为合法 UTF-8
    try {
      const strict = new TextDecoder('utf-8', { fatal: true });
      strict.decode(bytes.subarray(0, len));
      return 'utf-8';
    } catch {
      // 非 UTF-8：若存在 GBK 常见双字节区段，判为 GBK
      let gbkHits = 0;
      for (let i = 0; i + 1 < len; i++) {
        const b0 = bytes[i];
        const b1 = bytes[i + 1];
        // GBK 双字节：首字节 0x81-0xFE，次字节 0x40-0xFE（除 0x7F）
        if (b0 >= 0x81 && b0 <= 0xfe && b1 >= 0x40 && b1 <= 0xfe && b1 !== 0x7f) gbkHits++;
      }
      return gbkHits > len * 0.2 ? 'gb18030' : 'utf-8';
    }
  }

  /**
   * 文本预览：同源 fetch（自动携带会话 Cookie）后流式读取。
   * Content-Length 超过 2MB 或流式累积超限时立即停止，提示下载查看。
   * 依据响应 charset 头 / 字节探测选择 UTF-8 或 GBK 解码，避免中文乱码。
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
      // 依据响应头 charset 决定解码器；未声明时留待字节探测
      let label = resolveDecoderLabel(res.headers.get('Content-Type'));
      const body = res.body;
      if (!body) {
        const buf = await res.arrayBuffer();
        if (token !== epoch.value) return;
        if (buf.byteLength > TEXT_PREVIEW_LIMIT) {
          textTooLarge.value = true;
          return;
        }
        const bytes = new Uint8Array(buf);
        if (!label) label = detectEncoding(bytes);
        textContent.value = new TextDecoder(label, { fatal: false }).decode(bytes);
        return;
      }
      const reader = body.getReader();
      // 未声明 charset：先缓冲少量字节做编码探测，确定后再统一解码，避免中途换解码器产生乱码
      let probeBuf = label ? null : new Uint8Array(0);
      let decoder = new TextDecoder(label ?? 'utf-8', { fatal: false });
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
        if (probeBuf) {
          // 累积探测窗口（上限 8KB），未决定编码前不解码
          const next = new Uint8Array(probeBuf.length + value.byteLength);
          next.set(probeBuf);
          next.set(value, probeBuf.length);
          probeBuf = next;
          if (probeBuf.length >= 4096) {
            const decided = detectEncoding(probeBuf);
            label = decided;
            decoder = new TextDecoder(decided, { fatal: false });
            result += decoder.decode(probeBuf, { stream: true });
            probeBuf = null;
          }
          continue;
        }
        result += decoder.decode(value, { stream: true });
      }
      if (probeBuf && probeBuf.length > 0) {
        // 流结束仍未达到探测窗口：按已有字节探测
        const decided = detectEncoding(probeBuf);
        decoder = new TextDecoder(decided, { fatal: false });
        result += decoder.decode(probeBuf);
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
