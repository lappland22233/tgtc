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
import { AuthGuard } from '@nestjs/passport';
import { Request } from 'express';
import { ChunkUploadService } from './chunk-upload.service';
import { FileService } from './file.service';
import { InitChunkUploadDto, CompleteChunkUploadDto } from './chunk-upload.dto';

@Controller('files/chunk')
@UseGuards(AuthGuard('jwt'))
export class ChunkUploadController {
  constructor(
    private readonly chunkUploadService: ChunkUploadService,
    private readonly fileService: FileService,
  ) {}

  /** 初始化分片上传会话 */
  @Post('init')
  async init(@Body() dto: InitChunkUploadDto, @Req() req: Request) {
    return this.chunkUploadService.init(
      dto.fileName,
      dto.fileSize,
      dto.mimeType,
      dto.totalChunks,
      dto.chunkSize,
      (req.user as any).id,
    );
  }

  /** 查询已上传分片状态（断点续传依据） */
  @Get(':uploadId/status')
  async getStatus(@Param('uploadId') uploadId: string, @Req() req: Request) {
    return this.chunkUploadService.getStatus(uploadId, (req.user as any).id);
  }

  /** 上传单个分片 (multipart: chunk + index) */
  @Post(':uploadId')
  @UseInterceptors(FileInterceptor('chunk', { limits: { fileSize: 52428800 } }))
  async uploadChunk(
    @Param('uploadId') uploadId: string,
    @UploadedFile() chunk: Express.Multer.File,
    @Body('index') index: string,
    @Req() req: Request,
  ) {
    if (!chunk) {
      throw new BadRequestException('缺少分片数据 (chunk)');
    }
    if (!index) {
      throw new BadRequestException('缺少分片索引 (index)');
    }
    const chunkIndex = parseInt(index, 10);
    await this.chunkUploadService.saveChunk(uploadId, chunkIndex, chunk.buffer, (req.user as any).id);
    return { index: chunkIndex, received: true };
  }

  /** 启动异步合并（立即返回，后台执行合并+上传到 Telegram） */
  @Post(':uploadId/complete')
  complete(
    @Param('uploadId') uploadId: string,
    @Body() dto: CompleteChunkUploadDto,
    @Req() req: Request,
  ) {
    const user = req.user as any;
    this.chunkUploadService.triggerMerge(uploadId, user.id, async (file) => {
      return this.fileService.upload(file, user, dto.tagIds);
    });
    return { message: '合并任务已启动', status: 'processing' };
  }

  /** 取消上传并清理临时文件 */
  @Post(':uploadId/abort')
  async abort(@Param('uploadId') uploadId: string, @Req() req: Request) {
    await this.chunkUploadService.abort(uploadId, (req.user as any).id);
    return { message: '已取消上传' };
  }
}
