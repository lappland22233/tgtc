import { computed, ref } from 'vue';
import { defineStore } from 'pinia';
import {
  cancelDownloadTask,
  createDownloadTask,
  fetchDownloadTask,
  type DownloadQueueReason,
  type DownloadTaskMode,
  type DownloadTaskStatus,
} from '../api/download-task';
import { triggerBrowserDownload } from '../utils/download';
import { getDownloadErrorMessage } from '../utils/error';
import MessagePlugin from '../utils/message';

/** 前端任务模型（在服务端任务之上补充展示所需的文件名与来源页） */
export interface DownloadJob {
  taskId: string;
  fileId: string;
  fileName: string;
  /** 服务端给的下载地址（同源 cookie 鉴权；就绪时已自带一次性 taskTicket，无需前端拼接） */
  downloadUrl: string;
  status: DownloadTaskStatus;
  /** 传输模式：cache（缓存）或 direct（有界直通，不占本地缓存） */
  mode?: DownloadTaskMode;
  queueReason?: DownloadQueueReason;
  queuePosition?: number;
  /** 建议的重试间隔（毫秒），用于取消失败后按服务端节奏恢复轮询 */
  retryAfterMs?: number;
  message: string;
  createdAt: number;
}

/** 轮询退避边界：遵守服务端 retryAfterMs，同时避免过密轮询放大负载 */
const MIN_POLL_MS = 1000;
const MAX_POLL_MS = 5000;
/** 页面隐藏时降频倍数（避免后台标签页持续打扰服务器） */
const HIDDEN_BACKOFF = 4;

export const useDownloadsStore = defineStore('downloads', () => {
  /** 进行中与排队中的任务（完成/取消后自动移除） */
  const jobs = ref<DownloadJob[]>([]);
  const timers = new Map<string, ReturnType<typeof setTimeout>>();

  const activeJobs = computed(() => jobs.value);
  const queuedJobs = computed(() => jobs.value.filter(job => job.status === 'queued'));
  const hasActiveJobs = computed(() => jobs.value.length > 0);
  /** 服务器处于排队/高负载状态（供按钮与状态条提示） */
  const isServerBusy = computed(() => queuedJobs.value.length > 0);

  function removeJob(taskId: string, delayMs = 0): void {
    const apply = () => {
      jobs.value = jobs.value.filter(job => job.taskId !== taskId);
      const timer = timers.get(taskId);
      if (timer) {
        clearTimeout(timer);
        timers.delete(taskId);
      }
    };
    if (delayMs <= 0) {
      apply();
      return;
    }
    const timer = setTimeout(apply, delayMs);
    timers.set(taskId, timer);
  }

  function schedulePoll(taskId: string, retryAfterMs?: number): void {
    const existing = timers.get(taskId);
    if (existing) clearTimeout(existing);
    const base = Math.min(MAX_POLL_MS, Math.max(MIN_POLL_MS, retryAfterMs ?? MIN_POLL_MS));
    const hidden = typeof document !== 'undefined' && document.visibilityState === 'hidden';
    const delay = hidden ? base * HIDDEN_BACKOFF : base;
    const timer = setTimeout(() => {
      timers.delete(taskId);
      void poll(taskId);
    }, delay);
    timers.set(taskId, timer);
  }

  /**
   * 资源就绪（streamable）：立即交给浏览器原生下载器。
   * - 下载地址直接用服务端返回值（就绪时已自带一次性 `?taskTicket=`），前端不拼接；
   * - `mode: 'direct'` 是有界直通（不占本地缓存），只是提示文案不同，同样是「立即开始」；
   * - 浏览器原生下载器**不回传完成状态**，因此只能表达「已开始下载」，绝不写「下载成功」。
   */
  function triggerStreamableDownload(
    job: DownloadJob,
    view: { downloadUrl?: string; mode?: DownloadTaskMode },
  ): void {
    job.status = 'streamable';
    job.mode = view.mode;
    job.downloadUrl = view.downloadUrl ?? job.downloadUrl;
    triggerBrowserDownload(job.downloadUrl, job.fileName);
    MessagePlugin.success(
      view.mode === 'direct'
        ? `已开始直通下载「${job.fileName}」（不占本地缓存）`
        : `已开始下载「${job.fileName}」`,
    );
  }

  /**
   * 轮询一次任务状态。
   * 退避：遵守服务端 retryAfterMs（钳制到 [MIN, MAX]），页面隐藏时降频，失败按最大间隔重试。
   * 状态守卫：queued 继续排期；streamable 立即触发下载；cancelled/expired 为终态，停止轮询。
   */
  async function poll(taskId: string): Promise<void> {
    const job = jobs.value.find(item => item.taskId === taskId);
    if (!job) return;
    try {
      const view = await fetchDownloadTask(taskId);
      applyView(job, view);
      if (view.status === 'queued') {
        schedulePoll(taskId, view.retryAfterMs);
        return;
      }
      if (view.status === 'streamable') {
        triggerStreamableDownload(job, view);
        // 保留片刻，让全局指示器展示「已就绪 / 直通下载」后再移除
        removeJob(taskId, 2000);
        return;
      }
      // 终态：停止轮询（被其他入口取消 / 任务过期），保留片刻展示终态文案
      if (view.status === 'expired') {
        MessagePlugin.error(view.message ?? '下载任务已过期，请重新发起下载');
        removeJob(taskId, 1500);
        return;
      }
      if (view.status === 'cancelled') {
        MessagePlugin.info('下载任务已中断');
        removeJob(taskId, 1500);
        return;
      }
      // 未知状态兜底：避免无限轮询
      removeJob(taskId);
    } catch (error) {
      // 轮询失败（网络抖动/服务重启）：保留任务并退避重试一次，避免静默丢失
      job.message = getDownloadErrorMessage(error) ?? '下载状态查询失败，正在重试';
      schedulePoll(taskId, MAX_POLL_MS);
    }
  }

  function applyView(job: DownloadJob, view: {
    status: DownloadTaskStatus;
    mode?: DownloadTaskMode;
    queueReason?: DownloadQueueReason;
    queuePosition?: number;
    retryAfterMs?: number;
    message?: string;
    downloadUrl?: string;
  }): void {
    job.status = view.status;
    if (view.mode) job.mode = view.mode;
    job.queueReason = view.queueReason;
    job.queuePosition = view.queuePosition;
    job.retryAfterMs = view.retryAfterMs;
    job.message = view.message ?? '';
    if (view.downloadUrl) job.downloadUrl = view.downloadUrl;
  }

  /**
   * 发起下载：先创建任务，资源可用时立即触发原生下载；
   * 服务器繁忙时进入排队并返回排队说明，由全局指示器持续展示与取消。
   */
  async function requestDownload(input: {
    fileId: string;
    fileName: string;
    nocache?: boolean;
  }): Promise<DownloadJob | null> {
    const duplicated = jobs.value.find(
      job => job.fileId === input.fileId && job.status === 'queued',
    );
    if (duplicated) {
      MessagePlugin.info('该文件已在下载队列中，请勿重复点击');
      return duplicated;
    }
    const existingJob = jobs.value.find(job => job.fileId === input.fileId);
    if (existingJob) {
      MessagePlugin.info('该文件正在准备下载中，请稍候');
      return existingJob;
    }

    const view = await createDownloadTask(input.fileId, { nocache: input.nocache });
    const job: DownloadJob = {
      taskId: view.taskId,
      fileId: input.fileId,
      fileName: input.fileName,
      downloadUrl: view.downloadUrl ?? '',
      status: view.status,
      mode: view.mode,
      queueReason: view.queueReason,
      queuePosition: view.queuePosition,
      retryAfterMs: view.retryAfterMs,
      message: view.message ?? '',
      createdAt: Date.now(),
    };

    // 资源可用（含结构性不可行的 direct 直通）：立即触发下载，不进入队列视图
    if (view.status === 'streamable') {
      triggerStreamableDownload(job, view);
      return job;
    }
    // 创建即终态（极少见）：不进入轮询
    if (view.status === 'cancelled' || view.status === 'expired') {
      MessagePlugin.error(view.message ?? '下载任务不可用，请重新发起下载');
      return null;
    }

    jobs.value = [...jobs.value, job];
    MessagePlugin.info(view.message || '服务器当前下载任务较多，已加入排队，请稍候');
    schedulePoll(job.taskId, view.retryAfterMs);
    return job;
  }

  /**
   * 取消任务。以**服务端返回的状态**为准，不做乐观置为 cancelled：
   * - cancelled：取消生效，移除本地任务；
   * - expired：任务已过期，按过期提示并移除；
   * - streamable：预约已交接给正文请求（该次传输已开始），取消不再生效，按服务端状态收尾；
   * - 仍为 queued 或请求失败：保留任务并按服务端节奏恢复轮询，不误报「已取消」。
   */
  async function cancel(taskId: string): Promise<void> {
    const job = jobs.value.find(item => item.taskId === taskId);
    try {
      const view = await cancelDownloadTask(taskId);
      if (job) applyView(job, view);
      if (view.status === 'cancelled') {
        if (job) MessagePlugin.info(`已取消「${job.fileName}」的下载排队`);
        removeJob(taskId);
        return;
      }
      if (view.status === 'expired') {
        MessagePlugin.warning(view.message ?? '下载任务已过期，请重新发起下载');
        removeJob(taskId);
        return;
      }
      if (view.status === 'streamable') {
        // 资源已交给正文请求：取消不再生效，保留片刻展示「已开始」后移除
        MessagePlugin.info('该下载已开始，取消未生效');
        removeJob(taskId, 2000);
        return;
      }
      // 仍为 queued（取消失败但未报错）：保持任务并继续轮询
      if (job) schedulePoll(taskId, view.retryAfterMs);
    } catch (error) {
      MessagePlugin.error(getDownloadErrorMessage(error) ?? '取消失败，请稍后重试');
      // 取消失败不乐观改状态：保留任务并按既有退避继续轮询
      if (job) schedulePoll(taskId, job.retryAfterMs);
    }
  }

  /** 页面重新可见时立即刷新一次，避免后台降频导致的长时间延迟 */
  function refreshOnVisible(): void {
    if (typeof document === 'undefined') return;
    if (document.visibilityState !== 'visible') return;
    for (const job of jobs.value) {
      if (job.status === 'queued') void poll(job.taskId);
    }
  }

  /** 停止全部轮询（登出/离开页面时调用） */
  function stopAll(): void {
    for (const timer of timers.values()) clearTimeout(timer);
    timers.clear();
    jobs.value = [];
  }

  return {
    jobs,
    activeJobs,
    queuedJobs,
    hasActiveJobs,
    isServerBusy,
    requestDownload,
    cancel,
    refreshOnVisible,
    stopAll,
  };
});

/** 排队原因的展示文案（与后端 message 保持一致的语义） */
export function queueReasonLabel(reason?: DownloadQueueReason): string {
  switch (reason) {
    case 'upstream':
      return '服务器下载连接繁忙';
    case 'server_load':
      return '服务器负载较高';
    default:
      return '等待服务器释放磁盘空间';
  }
}

/**
 * 下载任务的状态文案（供全局指示器展示）。
 * 明确区分：排队中（带原因）/ 已就绪（正在交给浏览器）/ 直通下载 / 已中断 / 已过期。
 * 任何分支都只表达「已开始下载」，绝不出现「下载成功」（浏览器原生下载器不回传完成态）。
 */
export function downloadStatusLabel(
  job: Pick<DownloadJob, 'status' | 'mode' | 'message' | 'queueReason'>,
): string {
  switch (job.status) {
    case 'queued':
      return `排队中 · ${job.message || queueReasonLabel(job.queueReason)}`;
    case 'streamable':
      return job.mode === 'direct'
        ? '直通下载 · 不占本地缓存，已开始下载'
        : '已就绪 · 正在交给浏览器下载';
    case 'cancelled':
      return '已中断';
    case 'expired':
      return job.message || '已过期 · 请重新发起下载';
    default:
      return job.message || '处理中';
  }
}
