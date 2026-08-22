import {
  Controller,
  Post,
  Get,
  Param,
  Body,
  UploadedFile,
  UseInterceptors,
  UseGuards,
  BadRequestException,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { diskStorage } from 'multer';
import * as path from 'path';
import { randomUUID } from 'crypto';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { User } from '../common/entities/user.entity';
import { ChunkUploadService } from './chunk-upload.service';
import { InitChunkUploadDto, MAX_CHUNK_SIZE } from './chunk-upload.dto';
import { ChunkUploadResourceInterceptor } from './chunk-upload-resource.interceptor';

const incomingChunkDir = path.resolve(process.cwd(), 'tmp', 'uploads', 'incoming');

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
  @UseInterceptors(
    ChunkUploadResourceInterceptor,
    FileInterceptor('chunk', {
      storage: diskStorage({
        destination: incomingChunkDir,
        filename: (_req, _file, callback) => callback(null, `${randomUUID()}.part`),
      }),
      // busboy 在 fileSize === limit 时就会触发 limit 事件；上限需留 1 字节，
      // 才能允许合法的 MAX_CHUNK_SIZE 分片（恰好 16MiB）通过 Multer。
      limits: { fileSize: MAX_CHUNK_SIZE + 1, files: 1, fields: 1 },
    }),
  )
  async uploadChunk(
    @Param('uploadId') uploadId: string,
    @UploadedFile() chunk: Express.Multer.File,
    @Body('index') index: string,
    @CurrentUser() user: User,
  ) {
    if (!chunk) {
      throw new BadRequestException('缺少分片数据 (chunk)');
    }
    try {
      if (!index) {
        throw new BadRequestException('缺少分片索引 (index)');
      }
      if (!/^\d+$/.test(index)) {
        throw new BadRequestException('非法的分片索引');
      }
      const chunkIndex = Number(index);
      await this.chunkUploadService.saveChunkFromPath(uploadId, chunkIndex, chunk.path, chunk.size, user.id);
      return { index: chunkIndex, received: true };
    } catch (error) {
      await this.chunkUploadService.removeIncomingChunk(chunk.path);
      throw error;
    }
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
