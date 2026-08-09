import { Injectable, Logger } from '@nestjs/common';
import { Process, Processor } from '@nestjs/bull';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Job } from 'bull';
import { QUEUE_NAMES } from './bull-queue.module';
import { File } from '../common/entities/file.entity';
import { TelegramService } from '../telegram/telegram.service';
import { FileService } from '../file/file.service';
import { createReadStream, existsSync } from 'fs';
import { readFile, rename, unlink, writeFile } from 'fs/promises';

interface FileUploadJobData {
  fileId: string;
  filePath: string;
  uploadVersion: number;
}

@Injectable()
@Processor(QUEUE_NAMES.FILE_UPLOAD)
export class FileUploadProcessor {
  private readonly logger = new Logger(FileUploadProcessor.name);

  constructor(
    @InjectRepository(File)
    private fileRepository: Repository<File>,
    private telegramService: TelegramService,
    private fileService: FileService,
  ) {}

  private async removeTempFile(filePath: string): Promise<void> {
    await unlink(filePath).catch((err: Error) => {
      this.logger.warn(`临时文件删除失败 ${filePath}: ${err.message}`);
    });
  }

  private isCommitted(file: File): boolean {
    return file.uploadStage === 'remote_committed' || file.uploadStage === 'committed';
  }

  private receiptPath(filePath: string): string {
    return `${filePath}.telegram.json`;
  }

  private async persistReceipt(filePath: string, result: { file_id: string; file_path?: string }): Promise<void> {
    const receiptPath = this.receiptPath(filePath);
    const tmpPath = `${receiptPath}.tmp`;
    await writeFile(tmpPath, JSON.stringify(result), { flag: 'w' });
    await rename(tmpPath, receiptPath);
  }

  private async loadReceipt(filePath: string): Promise<{ file_id: string; file_path?: string } | null> {
    try {
      return JSON.parse(await readFile(this.receiptPath(filePath), 'utf8'));
    } catch {
      return null;
    }
  }

  private async removeUploadArtifacts(filePath: string): Promise<void> {
    await Promise.all([
      this.removeTempFile(filePath),
      unlink(this.receiptPath(filePath)).catch(() => {}),
    ]);
  }

  @Process({ name: 'upload', concurrency: 2 })
  async uploadToTelegram(job: Job<FileUploadJobData>): Promise<void> {
    const { fileId, filePath, uploadVersion } = job.data;
    const attempt = job.attemptsMade + 1;
    let file = await this.fileRepository.findOne({ where: { id: fileId } });
    if (!file) {
      this.logger.warn(`文件 ${fileId} 不存在，跳过上传`);
      await this.removeUploadArtifacts(filePath);
      return;
    }
    if (file.uploadVersion !== uploadVersion) {
      this.logger.warn(`忽略文件 ${fileId} 的陈旧上传任务 version=${uploadVersion}`);
      return;
    }

    if (!this.isCommitted(file)) {
      if (!existsSync(filePath)) {
        if (job.attemptsMade < 2) throw new Error(`临时文件暂不可用: ${filePath}`);
        await this.fileRepository.update(
          { id: fileId, uploadVersion },
          { status: 'error', uploadStage: 'failed' } as Partial<File>,
        );
        return;
      }

      await this.fileRepository.update(
        { id: fileId, uploadVersion, uploadStage: file.uploadStage },
        { uploadStage: 'uploading' } as Partial<File>,
      );
      file = await this.fileRepository.findOneOrFail({ where: { id: fileId } });

      try {
        let result = await this.loadReceipt(filePath);
        if (!result) {
          result = await this.telegramService.uploadFile(
            createReadStream(filePath),
            file.originalName,
            undefined,
            file.size,
          );
          // DB 提交失败前先原子保存回执，Bull 重试/进程重启可直接恢复提交。
          await this.persistReceipt(filePath, result);
        }
        // 远端结果是幂等提交点：一次原子更新同时写入 TG 引用与 remote_committed。
        await this.fileRepository.update(
          { id: fileId, uploadVersion },
          {
            filename: result.file_id,
            telegramFileId: result.file_id,
            telegramFilePath: result.file_path || '',
            uploadStage: 'remote_committed',
          } as Partial<File>,
        );
      } catch (error) {
        this.logger.warn(`文件远端上传或提交失败 (第 ${attempt} 次): ${(error as Error).message}`);
        const remoteReceipt = await this.loadReceipt(filePath);
        if (job.attemptsMade >= 2 && !remoteReceipt) {
          await this.fileRepository.update(
            { id: fileId, uploadVersion },
            { status: 'error', uploadStage: 'failed' } as Partial<File>,
          );
          await this.removeUploadArtifacts(filePath);
        }
        // 已有远端回执时必须保留本地文件/回执，后续以相同确定性 jobId 恢复 DB 提交。
        throw error;
      }
    }

    // 重新读取提交点，进程在 Telegram 成功后重启时会直接从这里恢复，绝不再次上传原文件。
    file = await this.fileRepository.findOneOrFail({ where: { id: fileId } });
    if (file.uploadVersion !== uploadVersion || !this.isCommitted(file)) return;

    await this.fileRepository.query(
      'UPDATE files SET status = $1 WHERE id = $2 AND status = $3',
      ['ready', fileId, 'processing'],
    );

    try {
      if (file.uploadStage !== 'committed') {
        if (file.mimeType?.startsWith('video/')) {
          await this.fileService.generateAndSaveVideoCover(file, { sourcePath: filePath });
        } else if (file.mimeType?.startsWith('image/')) {
          await this.fileService.generateAndSaveThumbnail(file);
        }
        await this.fileRepository.update(
          { id: fileId, uploadVersion },
          { uploadStage: 'committed' } as Partial<File>,
        );
      }
    } catch (error) {
      // 衍生媒体失败不回滚远端提交点，也不触发 Bull 原文件重试。
      this.logger.warn(`文件 ${fileId} 衍生媒体生成失败，原文件已提交: ${(error as Error).message}`);
    }

    await this.removeUploadArtifacts(filePath);
    this.logger.log(`文件上传完成: ${fileId}`);
  }
}
