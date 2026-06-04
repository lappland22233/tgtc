/**
 * 从 unknown 类型的 error 中提取可读的错误消息字符串
 * 支持 Error、AxiosError、网络错误、超时等场景
 */
export function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    if (error.name === 'AbortError' || error.message?.includes('timeout')) {
      return '请求超时，请重试';
    }
    if (error.message?.includes('Network Error')) {
      return '网络连接失败，请检查网络';
    }
    return error.message;
  }

  const axiosErr = error as {
    response?: { data?: { message?: string; statusCode?: number } };
    code?: string;
    message?: string;
  };
  if (axiosErr?.response?.data?.message) {
    return axiosErr.response.data.message;
  }
  if (axiosErr?.code === 'ECONNABORTED') {
    return '请求超时，请重试';
  }

  if (typeof error === 'string') {
    return error;
  }

  return '未知错误';
}
