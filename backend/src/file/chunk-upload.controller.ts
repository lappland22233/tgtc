import {
  Controller,
  Post,
  Get,
  Param,
  Body,
  UploadedFile,
  UseInterceptors,
  UseGuards,
  Req,
  BadRequestException,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { User } from '../common/entities/user.entity';
import { Request } from 'express';
import { ChunkUploadService } from './chunk-upload.service';
import { InitChunkUploadDto } from './chunk-upload.dto';

@Controller('files/chunk')
@UseGuards(JwtAuthGuard)
export class ChunkUploadController {
  constructor(
    private readonly chunkUploadService: ChunkUploadService,
  ) {}

  /** 初始化分片上传会话 */
  @Post('init')
  async init(@Body() dto: InitChunkUploadDto, @CurrentUser() user: User) {
    return this.chunkUploadService.init(
      dto.fileName,
      dto.fileSize,
      dto.mimeType,
      dto.totalChunks,
      dto.chunkSize,
      user.id,
      dto.folderId,
      dto.overwriteFileId,
    );
  }

  /** 查询已上传分片状态（断点续传依据） */
  @Get(':uploadId/status')
  async getStatus(@Param('uploadId') uploadId: string, @CurrentUser() user: User) {
    return this.chunkUploadService.getStatus(uploadId, user.id);
  }

  /** 上传单个分片 (multipart: chunk + index) */
  @Post(':uploadId')
  @UseInterceptors(FileInterceptor('chunk', { limits: { fileSize: 104857600 } }))
  async uploadChunk(
    @Param('uploadId') uploadId: string,
    @UploadedFile() chunk: Express.Multer.File,
    @Body('index') index: string,
    @Req() req: Request,
    @CurrentUser() user: User,
  ) {
    req.setTimeout(0);   // 禁用请求超时，防止慢速网络分片传输被 server.timeout 切断
    if (!chunk) {
      throw new BadRequestException('缺少分片数据 (chunk)');
    }
    if (!index) {
      throw new BadRequestException('缺少分片索引 (index)');
    }
    const chunkIndex = parseInt(index, 10);
    await this.chunkUploadService.saveChunk(uploadId, chunkIndex, chunk.buffer, user.id);
    return { index: chunkIndex, received: true };
  }

  /** 启动异步合并（立即返回，后台执行合并 → 入队 Telgram 上传） */
  @Post(':uploadId/complete')
  complete(
    @Param('uploadId') uploadId: string,
    @CurrentUser() user: User,
  ) {
    // uploadFn 已不再被 doMerge 使用（改为内部 createProcessingFile + Bull 队列）
    this.chunkUploadService.triggerMerge(uploadId, user.id, async () => ({ id: '', originalName: '' }));
    return { message: '文件正在后台处理，请稍后刷新文件列表查看', status: 'processing' };
  }

  /** 取消上传并清理临时文件 */
  @Post(':uploadId/abort')
  async abort(@Param('uploadId') uploadId: string, @CurrentUser() user: User) {
    await this.chunkUploadService.abort(uploadId, user.id);
    return { message: '已取消上传' };
  }
}
