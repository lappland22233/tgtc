import { CanActivate, ExecutionContext, HttpException, HttpStatus, Injectable } from '@nestjs/common';
import { Request } from 'express';
import { UploadDiskBudgetService } from './upload-disk-budget.service';

/**
 * 无缓存严格磁盘模式下，直传端点不能绕过分片上传的磁盘生命周期控制。
 * 严格模式下客户端必须统一使用 `/files/chunk`，这样所有文件都先取得同一份 2S 预算。
 */
@Injectable()
export class StrictUploadModeGuard implements CanActivate {
  constructor(private readonly uploadDiskBudget: UploadDiskBudgetService) {}

  canActivate(context: ExecutionContext): boolean {
    if (!this.uploadDiskBudget.isStrictMode()) return true;

    const request = context.switchToHttp().getRequest<Request>();
    // 健康检查等非 multipart 路由不会使用此守卫；所有直传正文均拒绝，避免 Content-Length
    // 缺失、分块编码或 multipart 信封大小造成旁路。
    if (!request.headers['content-type']?.toLowerCase().includes('multipart/form-data')) return true;

    throw new HttpException(
      {
        statusCode: HttpStatus.PAYLOAD_TOO_LARGE,
        code: 'STRICT_UPLOAD_REQUIRES_CHUNKED',
        message: '无缓存小盘模式下，大文件请使用支持分片上传的客户端',
      },
      HttpStatus.PAYLOAD_TOO_LARGE,
    );
  }
}
