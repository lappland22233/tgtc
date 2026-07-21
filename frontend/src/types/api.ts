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

/** 分页数据（与后端列表接口对齐） */
export interface PaginatedData<T> {
  /** 列表项 — 文件列表接口以 files 字段返回 */
  files: T[];
  total: number;
  /** 下一页游标（游标分页）；为 null 表示没有更多数据 */
  nextCursor?: string | null;
  /** 当前页码（偏移分页，部分接口未返回） */
  page?: number;
  /** 每页条数（偏移分页，部分接口未返回） */
  limit?: number;
  /** 是否有更多数据 */
  hasMore?: boolean;
}
