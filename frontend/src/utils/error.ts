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
    if (error.name === 'AbortError' || error.message?.includes('timeout')) {
      return '请求超时，请重试';
    }
    if (error.message?.includes('Network Error')) {
      return '网络连接失败，请检查网络';
    }
    return error.message;
  }

  if (typeof error === 'string') {
    return error;
  }

  return '未知错误';
}
