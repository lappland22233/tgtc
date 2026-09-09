import { defineStore } from 'pinia';
import { ref, watch } from 'vue';
import api from '../api/client';

/** 标题缺失 / 非字符串 / 空白时的统一回退值，与后端 public-config.service 一致 */
export const DEFAULT_SITE_TITLE = '文件分发系统';

/** 初始化读取的超时上限：超时或失败均保留当前标题，不阻塞应用启动 */
const FETCH_TIMEOUT_MS = 2_000;

/**
 * 公共配置的单一响应式来源。
 *
 * 解决标题来源割裂问题：此前 document.title 仅在启动时独立请求一次，
 * 侧栏标题硬编码，设置页保存后只回写局部表单，各展示位互不同步。
 * 现在启动初始化、设置页保存、SideNav 展示与浏览器标签共用此 store。
 */
export const usePublicConfigStore = defineStore('public-config', () => {
  const siteTitle = ref(DEFAULT_SITE_TITLE);
  /** 是否至少成功读取过一次服务端标题 */
  const loaded = ref(false);

  /** 本地修订号：保存成功后递增，使在途的旧读取响应过期，防止迟到响应覆盖新标题 */
  let revision = 0;
  /** 并发去重：同一时刻最多一个在途请求，启动 / 侧栏 / 设置页共用 */
  let inflight: Promise<boolean> | null = null;

  function normalize(value: unknown): string {
    const trimmed = typeof value === 'string' ? value.trim() : '';
    return trimmed || DEFAULT_SITE_TITLE;
  }

  /**
   * 读取服务端公共配置中的网站标题。
   * - 成功：更新标题（服务端已对空值做默认回退，此处再防御一次）；
   * - 失败 / 超时：保留最后成功值（首次为默认值），返回 false 供调用方提示；
   * - 请求期间若发生本地保存（revision 变化），丢弃该响应避免旧值回写。
   */
  function fetchSiteTitle(): Promise<boolean> {
    if (inflight) return inflight;
    const requestRevision = revision;
    inflight = api
      .get('/public-config', { timeout: FETCH_TIMEOUT_MS })
      .then((res) => {
        if (revision === requestRevision) {
          siteTitle.value = normalize(res.data?.data?.siteTitle);
          loaded.value = true;
        }
        return true;
      })
      .catch((error: unknown) => {
        const reason = error instanceof Error ? error.message : String(error);
        console.warn('[PublicConfig] 读取网站标题失败（保留当前标题）:', reason);
        return false;
      })
      .finally(() => {
        inflight = null;
      });
    return inflight;
  }

  /** 设置页保存成功后的本地提交：立即同步侧栏与浏览器标签，无需重新拉取 */
  function setSiteTitle(title: string): void {
    revision += 1;
    siteTitle.value = normalize(title);
    loaded.value = true;
  }

  // 浏览器标签标题与导航标题同源响应式同步（替代启动时的一次性设置）；
  // sync 保证 document.title 与状态严格同拍，无中间渲染窗口
  watch(siteTitle, (title) => {
    document.title = title;
  }, { immediate: true, flush: 'sync' });

  return { siteTitle, loaded, fetchSiteTitle, setSiteTitle };
});
