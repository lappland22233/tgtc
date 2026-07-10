import { Injectable, Logger } from '@nestjs/common';
import { Process, Processor } from '@nestjs/bull';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Job } from 'bull';
import { QUEUE_NAMES } from './bull-queue.module';
import { File } from '../common/entities/file.entity';
import { TelegramService } from '../telegram/telegram.service';
import { createReadStream, existsSync } from 'fs';
import { unlink } from 'fs/promises';

@Injectable()
@Processor(QUEUE_NAMES.FILE_UPLOAD)
export class FileUploadProcessor {
  private readonly logger = new Logger(FileUploadProcessor.name);

  constructor(
    @InjectRepository(File)
    private fileRepository: Repository<File>,
    private telegramService: TelegramService,
  ) {}

  /**
   * 后台异步上传文件到 Telegram
   * Bull 自动重试最多 3 次（指数退避 10s/20s/40s）
   */
  @Process({
    name: 'upload',
    concurrency: 2,
  })
  async uploadToTelegram(job: Job<{ fileId: string; filePath: string }>): Promise<void> {
    const { fileId, filePath } = job.data;
    const attempt = job.attemptsMade + 1;
    this.logger.log(`开始上传文件到 Telegram: ${fileId} (第 ${attempt}/3 次尝试)`);

    const file = await this.fileRepository.findOne({ where: { id: fileId } });
    if (!file) {
      this.logger.warn(`文件 ${fileId} 不存在，跳过上传`);
      return;
    }

    if (!existsSync(filePath)) {
      this.logger.error(`文件 ${fileId} 的临时文件不存在: ${filePath}`);
      await this.fileRepository.update(fileId, { status: 'error' as any });
      return;
    }

    try {
      const stream = createReadStream(filePath);
      const result = await this.telegramService.uploadFile(
        stream,
        file.originalName,
        undefined,
        file.size,
      );

      // TG 上传成功：更新 ID + 兜底写 status ready（正常情况缓存预热已先设为 ready）
      await this.fileRepository.update(fileId, {
        filename: result.file_id,
        telegramFileId: result.file_id,
        telegramFilePath: result.file_path || '',
      } as any);
      // 若缓存预热失败导致 status 仍为 processing，则补齐 ready
      await this.fileRepository.query(
        'UPDATE files SET status = $1 WHERE id = $2 AND status = $3',
        ['ready', fileId, 'processing'],
      );

      await unlink(filePath).catch(() => {});
      this.logger.log(`文件上传完成: ${fileId}`);
    } catch (error) {
      const msg = (error as Error).message;
      this.logger.warn(`文件上传失败 (第 ${attempt}/3 次尝试): ${msg}`);

      if (job.attemptsMade >= 2) {
        // 最终失败：仅当文件仍为 processing（缓存预热也失败）时才标记 error
        await this.fileRepository.query(
          'UPDATE files SET status = $1 WHERE id = $2 AND status = $3',
          ['error', fileId, 'processing'],
        );
        await unlink(filePath).catch(() => {});
        this.logger.error(`文件 ${fileId} 上传最终失败(3次重试后): ${msg}`);
      }

      throw error;
    }
  }
}
