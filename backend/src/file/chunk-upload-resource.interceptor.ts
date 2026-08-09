import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import { Observable, finalize } from 'rxjs';
import { Request } from 'express';
import { ChunkUploadService } from './chunk-upload.service';

@Injectable()
export class ChunkUploadResourceInterceptor implements NestInterceptor {
  constructor(private readonly chunkUploadService: ChunkUploadService) {}

  async intercept(context: ExecutionContext, next: CallHandler): Promise<Observable<unknown>> {
    const request = context.switchToHttp().getRequest<Request & { user?: { id?: string } }>();
    const contentLength = Number(request.headers['content-length'] || 0);
    const release = await this.chunkUploadService.acquireChunkRequest(
      request.params.uploadId,
      request.user?.id || '',
      contentLength,
    );

    return next.handle().pipe(finalize(release));
  }
}
