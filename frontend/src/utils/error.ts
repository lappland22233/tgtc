/**
 * 从 unknown 类型的 error 中提取可读的错误消息字符串
 */
export function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  const axiosErr = error as { response?: { data?: { message?: string } } };
  if (axiosErr?.response?.data?.message) {
    return axiosErr.response.data.message;
  }

  if (typeof error === 'string') {
    return error;
  }

  return '未知错误';
}
