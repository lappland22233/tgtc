/** 错误代码枚举 */
export enum ApiErrorCode {
  SUCCESS = 0,
  INVALID_INPUT = 400,
  UNAUTHORIZED = 401,
  FORBIDDEN = 403,
  NOT_FOUND = 404,
  CONFLICT = 409,
  INTERNAL_ERROR = 500,
  SERVICE_UNAVAILABLE = 503,
}

/** 成功响应 */
export interface ApiSuccessResponse<T> {
  code: 0;
  message: string;
  data: T;
}

/** 错误响应 */
export interface ApiErrorResponse {
  code: number;
  message: string;
  data: null;
  details?: Record<string, string[]>;
}

/** 联合类型：成功或错误响应 */
export type ApiResponse<T> = ApiSuccessResponse<T> | ApiErrorResponse;

/** 分页数据 */
export interface PaginatedData<T> {
  items: T[];
  total: number;
  /** 当前页码（预留字段，部分接口未返回） */
  page?: number;
  /** 每页条数（预留字段，部分接口未返回） */
  limit?: number;
  /** 是否有更多数据（预留字段） */
  hasMore?: boolean;
}
