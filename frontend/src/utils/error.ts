/**
 * 从 unknown 类型的 error 中提取可读的错误消息字符串
 * 支持 AxiosError（含后端统一响应 { message }）、Error、网络错误、超时等场景
 */
export function getErrorMessage(error: unknown): string {
  // 优先从 Axios 响应中提取后端返回的 message（BadRequestException 等）
  const axiosErr = error as {
    response?: { data?: { message?: string; statusCode?: number } };
    code?: string;
    message?: string;
  };
  if (axiosErr?.response?.data?.message) {
    return axiosErr.response.data.message;
  }

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
