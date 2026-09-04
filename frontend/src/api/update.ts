import api from './client';
import type {
  UpdateCheckResult,
  UpdateStatusResponse,
  UpdateTaskSummary,
} from '../types/update';

/**
 * 系统更新管理端 API 封装（全部仅 super_admin 可用）。
 * 后端全局 TransformInterceptor 将响应包装为 { code, message, data }，此处统一解包。
 */
function unwrap<T>(body: unknown): T {
  return (body as { data: T }).data;
}

/** 聚合状态：当前版本、检查结果、开关与活动任务摘要 */
export async function fetchUpdateStatus(): Promise<UpdateStatusResponse> {
  const response = await api.get('/admin/update/status');
  return unwrap<UpdateStatusResponse>(response.data);
}

/** 强制检查最新稳定版 */
export async function checkUpdate(): Promise<UpdateCheckResult> {
  const response = await api.post('/admin/update/check');
  return unwrap<UpdateCheckResult>(response.data);
}

/** 基于候选 releaseId 创建安装任务（二次确认由页面负责） */
export async function installUpdate(releaseId: number): Promise<UpdateTaskSummary> {
  const response = await api.post('/admin/update/install', { releaseId });
  return unwrap<UpdateTaskSummary>(response.data);
}

/** 最近更新任务历史 */
export async function fetchUpdateTasks(limit = 10): Promise<UpdateTaskSummary[]> {
  const response = await api.get('/admin/update/tasks', { params: { limit } });
  return unwrap<{ tasks: UpdateTaskSummary[] }>(response.data).tasks;
}

/** 单个任务详情（用于刷新后恢复进度） */
export async function fetchUpdateTask(taskId: string): Promise<UpdateTaskSummary> {
  const response = await api.get(`/admin/update/tasks/${taskId}`);
  return unwrap<UpdateTaskSummary>(response.data);
}

/** 取消仍处于安全阶段的任务 */
export async function cancelUpdateTask(taskId: string): Promise<UpdateTaskSummary> {
  const response = await api.post(`/admin/update/tasks/${taskId}/cancel`);
  return unwrap<UpdateTaskSummary>(response.data);
}
