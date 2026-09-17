import { computed, ref } from 'vue';
import { defineStore } from 'pinia';
import {
  cancelDownloadTask,
  createDownloadTask,
  fetchDownloadTask,
  type DownloadQueueReason,
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
  /** 服务端给的下载地址（同源 cookie 鉴权） */
  downloadUrl: string;
  status: DownloadTaskStatus;
  queueReason?: DownloadQueueReason;
  queuePosition?: number;
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

  /** 轮询一次任务状态；streamable 时立即触发浏览器原生下载 */
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
        job.status = 'streamable';
        job.downloadUrl = view.downloadUrl ?? job.downloadUrl;
        triggerBrowserDownload(job.downloadUrl, job.fileName);
        MessagePlugin.success(`已开始下载「${job.fileName}」`);
        removeJob(taskId, 2000);
        return;
      }
      if (view.status === 'expired') {
        MessagePlugin.error(view.message ?? '下载任务已过期，请重新发起下载');
        removeJob(taskId);
        return;
      }
      removeJob(taskId);
    } catch (error) {
      // 轮询失败（网络抖动/服务重启）：保留任务并退避重试一次，避免静默丢失
      job.message = getDownloadErrorMessage(error) ?? '下载状态查询失败，正在重试';
      schedulePoll(taskId, MAX_POLL_MS);
    }
  }

  function applyView(job: DownloadJob, view: {
    status: DownloadTaskStatus;
    queueReason?: DownloadQueueReason;
    queuePosition?: number;
    message?: string;
    downloadUrl?: string;
  }): void {
    job.status = view.status;
    job.queueReason = view.queueReason;
    job.queuePosition = view.queuePosition;
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
      queueReason: view.queueReason,
      queuePosition: view.queuePosition,
      message: view.message ?? '',
      createdAt: Date.now(),
    };

    if (view.status === 'streamable') {
      triggerBrowserDownload(job.downloadUrl, job.fileName);
      return job;
    }

    jobs.value = [...jobs.value, job];
    MessagePlugin.info(view.message || '服务器当前下载任务较多，已加入排队，请稍候');
    schedulePoll(job.taskId, view.retryAfterMs);
    return job;
  }

  /** 取消排队中的任务 */
  async function cancel(taskId: string): Promise<void> {
    const job = jobs.value.find(item => item.taskId === taskId);
    try {
      await cancelDownloadTask(taskId);
      if (job) MessagePlugin.info(`已取消「${job.fileName}」的下载排队`);
    } catch (error) {
      MessagePlugin.error(getDownloadErrorMessage(error) ?? '取消失败，请稍后重试');
    } finally {
      removeJob(taskId);
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
