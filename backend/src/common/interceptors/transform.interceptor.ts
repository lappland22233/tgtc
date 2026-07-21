import {
  Injectable,
  NestInterceptor,
  ExecutionContext,
  CallHandler,
} from '@nestjs/common';
import { Observable } from 'rxjs';
import { map } from 'rxjs/operators';

export interface ApiResponse<T> {
  code: number;
  message: string;
  data: T;
}

/**
 * 成功响应统一包装为 { code: 0, message: 'success', data }。
 * 注意：本拦截器仅处理成功响应；异常响应由全局 GlobalExceptionFilter
 * （在 main.ts 注册）统一为 { code, message, data: null } 结构，
 * 以保证成功/错误响应契约一致。
 */
@Injectable()
export class TransformInterceptor<T>
  implements NestInterceptor<T, ApiResponse<T>>
{
  intercept(
    context: ExecutionContext,
    next: CallHandler,
  ): Observable<ApiResponse<T>> {
    return next.handle().pipe(
      map((data) => {
        // 跳过已由 @Res() 手动处理的响应（如文件下载流）
        const res = context.switchToHttp().getResponse();
        if (res.headersSent) {
          return data;
        }
        return {
          code: 0,
          message: 'success',
          data,
        };
      }),
    );
  }
}
