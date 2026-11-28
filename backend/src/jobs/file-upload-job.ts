/**
 * A-17：`file-upload` 队列 jobId 与重试选项的单一事实来源。
 *
 * jobId 是幂等与取消的唯一键：`abort`、僵尸恢复、回执恢复都按它 `getJob`。
 * 此前该格式在 4 个文件里手写，任一处改格式都会让取消与恢复**静默失效**
 * （找不到 job → 误判「已被 Worker 接管」，于是既不取消也不恢复）。
 */

/** 上传任务的基础 jobId（同一文件同一版本全局唯一） */
export function fileUploadJobId(fileId: string, uploadVersion: number): string {
  return `file-upload:${fileId}:${uploadVersion}`;
}

/**
 * 准入排队延后的派生 jobId：同一文件同一版本的多轮延后互不覆盖，
 * 且仍以基础 jobId 为前缀，便于按前缀识别「该文件是否有排队中的准入任务」。
 */
export function fileUploadAdmissionJobId(
  fileId: string,
  uploadVersion: number,
  admissionAttempt: number,
): string {
  return `${fileUploadJobId(fileId, uploadVersion)}:admission:${admissionAttempt}`;
}

/**
 * 上传任务统一重试与保留策略。
 *
 * 注意：恢复路径（TasksService.recoverUpload）刻意用 `removeOnFail: false`
 * 保留失败任务以便人工排查与再次 retry，不适用本常量，需显式覆盖。
 */
export const FILE_UPLOAD_JOB_OPTIONS = {
  attempts: 3,
  backoff: { type: 'exponential' as const, delay: 10000 },
  removeOnComplete: 100,
  removeOnFail: 50,
};