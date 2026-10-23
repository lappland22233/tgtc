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

/**
 * 上传调度业务码：严格小盘模式下「整文件上传通道被上一份文件占用」的排队信号。
 * 它与磁盘余量无关（后端只做进程内租约判断），因此绝不能被归类为存储空间不足，
 * 也不能被 client.ts 的全局可用性告警消费——等待与重试由上传层自己负责。
 */
export const UPLOAD_DISK_BUDGET_BUSY_CODE = 'UPLOAD_DISK_BUDGET_BUSY';

const UPLOAD_SCHEDULE_ERROR_CODES = new Set<string>([UPLOAD_DISK_BUDGET_BUSY_CODE]);

/** 排队等待间隔的默认值与合法区间（ms），与后端 retryAfterMs 契约一致 */
const DEFAULT_UPLOAD_BUDGET_RETRY_AFTER_MS = 5000;
const MIN_UPLOAD_BUDGET_RETRY_AFTER_MS = 1000;
const MAX_UPLOAD_BUDGET_RETRY_AFTER_MS = 60_000;

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

/**
 * 提取业务码：全局过滤器的出参里顶层 `code` 恒为数字 HTTP 状态，业务码只落在 `errorCode`
 * （见 common/filters/http-exception.filter.ts）；历史响应可能把字符串业务码放在 `code`。
 * 因此优先取字符串业务码，两者都非字符串时才回退原始 `code`。
 */
function pickBusinessCode(
  data: { code?: string | number; errorCode?: string | number } | undefined,
): string | number | undefined {
  if (typeof data?.errorCode === 'string' && data.errorCode) return data.errorCode;
  if (typeof data?.code === 'string' && data.code) return data.code;
  return data?.code ?? data?.errorCode;
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
    code: pickBusinessCode(data),
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
  // 上传调度类错误（严格小盘模式的串行上传名额被占用）同理：其文案常含「磁盘」字样，
  // 若落进下面的 mentionsStorage 分支会把排队误报成「存储空间不足」。
  if (UPLOAD_SCHEDULE_ERROR_CODES.has(normalizedCode) || isUploadBudgetBusy(error)) return null;
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

// ---- 上传磁盘预算（严格小盘模式排队）识别 ----

interface BudgetErrorNode {
  response?: {
    status?: unknown;
    data?: { code?: unknown; errorCode?: unknown; retryAfterMs?: unknown };
    headers?: unknown;
  };
  cause?: unknown;
}

/**
 * 错误对象及其 cause 链（最多 5 层）。
 * client.ts 的拦截器会把部分 AxiosError 包装成普通 Error 并保留 cause，
 * 沿链回溯才能在后端响应被包装后仍识别出排队信号。
 */
function collectErrorChain(error: unknown): BudgetErrorNode[] {
  const chain: BudgetErrorNode[] = [];
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current && typeof current === 'object'; depth++) {
    chain.push(current as BudgetErrorNode);
    current = (current as BudgetErrorNode).cause;
  }
  return chain;
}

/** 大小写不敏感地读取响应头（兼容普通对象与 AxiosHeaders），取不到返回 undefined。 */
function readResponseHeader(headers: unknown, name: string): string | undefined {
  if (!headers || typeof headers !== 'object') return undefined;
  const record = headers as Record<string, unknown> & { get?: (key: string) => unknown };
  const direct = record[name];
  if (typeof direct === 'string' && direct) return direct;
  if (typeof direct === 'number') return String(direct);
  const target = name.toLowerCase();
  for (const key of Object.keys(record)) {
    if (key.toLowerCase() !== target) continue;
    const value = record[key];
    if (typeof value === 'string' && value) return value;
    if (typeof value === 'number') return String(value);
  }
  if (typeof record.get === 'function') {
    const viaGetter = record.get(target);
    if (typeof viaGetter === 'string' && viaGetter) return viaGetter;
  }
  return undefined;
}

/**
 * 单层错误节点是否携带上传排队业务码（响应体 errorCode/code 或 X-Tgtc-Error-Code 头）。
 * 仅接受 429（或缺省状态，兼容 cause 包装层）：若某 5xx 也带该码，说明是我们的服务端/代理出问题，
 * 不能当作排队去 5s×N 等待。
 */
function isUploadBudgetBusyNode(node: BudgetErrorNode): boolean {
  const status = node.response?.status;
  if (status !== undefined && status !== 429) return false;
  const data = node.response?.data;
  const bodyCode = typeof data?.errorCode === 'string' && data.errorCode
    ? data.errorCode
    : typeof data?.code === 'string' && data.code
      ? data.code
      : undefined;
  if (bodyCode === UPLOAD_DISK_BUDGET_BUSY_CODE) return true;
  return readResponseHeader(node.response?.headers, 'x-tgtc-error-code') === UPLOAD_DISK_BUDGET_BUSY_CODE;
}

/**
 * 当前错误是否表示「服务器正在依次处理另一份大文件，本文件需要排队」。
 * 后端只把该业务码放在 errorCode（顶层 code 是数字 429），历史写法可能放在 code。
 */
export function isUploadBudgetBusy(error: unknown): boolean {
  return collectErrorChain(error).some(isUploadBudgetBusyNode);
}

/**
 * 排队等待间隔（ms）：响应体 retryAfterMs → Retry-After 头 → 默认 5000。
 * 非排队类错误返回 null，调用方据此回退到常规瞬时错误处理。
 * 服务端给出的间隔只做上限收敛（夹到 60s）；过小或非法值丢弃并回退默认值，
 * 避免把明显异常的间隔当作真实排队节奏。
 */
export function getUploadBudgetRetryAfterMs(error: unknown): number | null {
  let busy = false;
  for (const node of collectErrorChain(error)) {
    if (!isUploadBudgetBusyNode(node)) continue;
    busy = true;
    const bodyRetryAfterMs = Number(node.response?.data?.retryAfterMs);
    if (Number.isSafeInteger(bodyRetryAfterMs) && bodyRetryAfterMs >= MIN_UPLOAD_BUDGET_RETRY_AFTER_MS) {
      return Math.min(bodyRetryAfterMs, MAX_UPLOAD_BUDGET_RETRY_AFTER_MS);
    }
    const retryAfterSeconds = Number(readResponseHeader(node.response?.headers, 'retry-after'));
    if (Number.isFinite(retryAfterSeconds) && retryAfterSeconds >= 1) {
      return Math.min(retryAfterSeconds * 1000, MAX_UPLOAD_BUDGET_RETRY_AFTER_MS);
    }
    // 本节点未给出可用间隔（如响应体只有业务码）：继续沿 cause 链寻找更深层的响应
  }
  return busy ? DEFAULT_UPLOAD_BUDGET_RETRY_AFTER_MS : null;
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
