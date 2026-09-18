export interface ApiErrorDetails {
  status?: number;
  code?: string | number;
  message?: string;
}

export interface ServiceAvailabilityError {
  kind: 'storage_full' | 'service_unavailable' | 'file_unavailable';
  message: string;
}

const STORAGE_ERROR_CODES = new Set([
  'INSUFFICIENT_STORAGE',
  'DISK_FULL',
  'DISK_SPACE_LOW',
  'DISK_SPACE_CRITICAL',
  'STORAGE_UNAVAILABLE',
  'TELEGRAM_STORAGE_UNAVAILABLE',
]);

/**
 * 下载调度业务码（资源协调器 / 下载任务）：
 * 这些场景有各自的排队与重试语义，必须由下载入口展示具体文案，
 * 不能被通用「文件服务暂时不可用 / 存储空间不足」提示覆盖。
 */
const DOWNLOAD_SCHEDULE_ERROR_CODES = new Set([
  'DOWNLOAD_QUEUE_FULL',
  'DOWNLOAD_QUEUE_TIMEOUT',
  'DOWNLOAD_QUEUE_CANCELLED',
  'DOWNLOAD_SERVER_BUSY',
  'DOWNLOAD_STORAGE_PROBE_UNAVAILABLE',
  'DOWNLOAD_INSUFFICIENT_STORAGE',
  'DOWNLOAD_SHUTTING_DOWN',
  'DOWNLOAD_TASK_EXPIRED',
]);

/** 下载调度业务码 → 用户可读文案 */
export const DOWNLOAD_ERROR_MESSAGES: Record<string, string> = {
  DOWNLOAD_QUEUE_FULL: '服务器当前下载任务较多，请稍后重试',
  DOWNLOAD_QUEUE_TIMEOUT: '等待时间过长，请稍后重新下载',
  DOWNLOAD_QUEUE_CANCELLED: '下载任务已取消',
  DOWNLOAD_SERVER_BUSY: '服务器下载连接繁忙，请稍后重试',
  DOWNLOAD_STORAGE_PROBE_UNAVAILABLE: '服务器暂时无法确认存储状态，请稍后重试',
  DOWNLOAD_INSUFFICIENT_STORAGE: '服务器存储空间不足，暂时无法准备此文件',
  DOWNLOAD_SHUTTING_DOWN: '服务正在重启，请稍后重试',
  DOWNLOAD_TASK_EXPIRED: '下载任务已过期，请重新发起下载',
};

/**
 * 提取下载调度业务码及其文案。
 * 若非下载类错误返回 null，调用方应回退到通用错误处理。
 */
export function getDownloadError(error: unknown): { code: string; message: string } | null {
  const { code, message } = getApiErrorDetails(error);
  const normalized = String(code ?? '').toUpperCase();
  if (!DOWNLOAD_SCHEDULE_ERROR_CODES.has(normalized)) return null;
  return {
    code: normalized,
    message: DOWNLOAD_ERROR_MESSAGES[normalized] ?? message ?? '下载暂时不可用，请稍后重试',
  };
}

/** 下载调度错误文案（无匹配时回退通用文案） */
export function getDownloadErrorMessage(error: unknown): string | undefined {
  const download = getDownloadError(error);
  if (download) return download.message;
  return undefined;
}

/** 从 Axios/NestJS 统一错误响应中提取状态、业务码和消息。 */
export function getApiErrorDetails(error: unknown): ApiErrorDetails {
  const axiosErr = error as {
    response?: {
      status?: number;
      data?: { message?: string | string[]; code?: string | number; errorCode?: string | number };
    };
  };
  const data = axiosErr?.response?.data;
  const rawMessage = data?.message;
  return {
    status: axiosErr?.response?.status,
    code: data?.code ?? data?.errorCode,
    message: Array.isArray(rawMessage) ? rawMessage.join('；') : rawMessage,
  };
}

/**
 * 将需要全局告知用户的基础设施故障映射为稳定、可操作的文案。
 * 507 或明确的磁盘业务码优先判定为空间不足；普通 503 不臆测磁盘原因。
 */
export function classifyServiceAvailabilityError(error: unknown): ServiceAvailabilityError | null {
  const { status, code, message } = getApiErrorDetails(error);
  const normalizedCode = String(code ?? '').toUpperCase();
  // 下载调度类错误有独立的排队/重试文案，不做通用基础设施故障归类
  if (DOWNLOAD_SCHEDULE_ERROR_CODES.has(normalizedCode)) return null;
  const normalizedMessage = (message ?? '').toLowerCase();
  const mentionsStorage = /磁盘|空间不足|存储空间|disk\s*(?:full|space)|no space left|insufficient storage/.test(normalizedMessage);

  if (status === 507 || STORAGE_ERROR_CODES.has(normalizedCode) || mentionsStorage) {
    return {
      kind: 'storage_full',
      message: '服务器存储空间不足，文件服务暂时不可用。请稍后重试或联系管理员。',
    };
  }

  if (status === 502 || status === 503 || normalizedCode === 'SERVICE_UNAVAILABLE' || normalizedCode === 'TELEGRAM_UNAVAILABLE') {
    return {
      kind: 'service_unavailable',
      message: '文件服务暂时不可用，请稍后重试。若问题持续，请联系管理员。',
    };
  }

  // 410 Gone：文件已不可用（永久失效，非临时网关错误），独立于 502/503 处理
  if (status === 410) {
    return {
      kind: 'file_unavailable',
      message: '文件已不可用',
    };
  }

  return null;
}

/**
 * 从 unknown 类型的 error 中提取可读的错误消息字符串
 * 支持 AxiosError（含后端统一响应 { message }）、Error、网络错误、超时等场景
 */
export function getErrorMessage(error: unknown): string {
  const availabilityError = classifyServiceAvailabilityError(error);
  if (availabilityError) return availabilityError.message;

  const details = getApiErrorDetails(error);
  if (details.message) {
    return details.message;
  }

  const axiosErr = error as {
    code?: string;
    message?: string;
  };

  // 网络超时
  if (axiosErr?.code === 'ECONNABORTED') {
    return '请求超时，请重试';
  }

  // 通用 Error（AxiosError 也是 Error 实例，需放在 response 检查之后）
  if (error instanceof Error) {
    // 主动取消（AbortError）不应显示为错误，但返回可读文案避免调用方弹空 toast
    if (error.name === 'AbortError') {
      return '操作已取消';
    }
    if (error.message?.includes('timeout')) {
      return '请求超时，请重试';
    }
    if (error.message?.includes('Network Error')) {
      return '网络连接失败，请检查网络';
    }
    // 兜底：原始 message 可能含内部 URL/堆栈等细节，过滤后再展示，避免信息泄漏
    const msg = error.message || '';
    if (!msg || /https?:\/\//i.test(msg) || msg.includes('\n')) {
      return '操作失败，请稍后重试';
    }
    return msg;
  }

  if (typeof error === 'string') {
    return error;
  }

  return '未知错误';
}
