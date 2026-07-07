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
