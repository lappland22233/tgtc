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

  private async persistReceipt(
    filePath: string,
    result: { file_id: string; file_path?: string },
    uploadVersion: number,
  ): Promise<void> {
    const receiptPath = this.receiptPath(filePath);
    const tmpPath = `${receiptPath}.tmp`;
    // G3-12：回执必须绑定 uploadVersion，防止覆盖上传复用同路径时读到陈旧回执提交错配内容。
    await writeFile(tmpPath, JSON.stringify({ ...result, uploadVersion }), { flag: 'w' });
    await rename(tmpPath, receiptPath);
  }

  private async loadReceipt(
    filePath: string,
    expectedUploadVersion?: number,
  ): Promise<{ file_id: string; file_path?: string; uploadVersion?: number } | null> {
    try {
      const receipt = JSON.parse(await readFile(this.receiptPath(filePath), 'utf8'));
      // G3-12：回执版本不匹配当前任务视为无效（可能残留自旧版本上传），交由重新上传。
      if (expectedUploadVersion !== undefined && receipt.uploadVersion !== expectedUploadVersion) {
        return null;
      }
      return receipt;
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

  /**
   * 将最终失败原因安全化为可持久化的诊断摘要：
   * 不保存本地路径、控制字符、Token 或冗长堆栈，长度受限后写入 DB。
   */
  private safeFailureReason(message: string, filePath?: string): string {
    const raw = filePath ? message.split(filePath).join('临时文件') : message;
    return raw
      .replace(/[\u0000-\u001F\u007F]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 1000);
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
          {
            status: 'error',
            uploadStage: 'failed',
            // 固定原因，不包含本地路径，避免泄露服务器目录结构
            uploadFailureReason: '临时文件缺失，上传已放弃',
          } as Partial<File>,
        );
        this.logger.warn(
          `文件上传最终失败并标记 error: fileId=${fileId} uploadVersion=${uploadVersion} 原因=临时文件缺失 (第 ${attempt} 次尝试后放弃)`,
        );
        return;
      }

      // G3-13：CAS 升 uploading 必须校验 affected。若 0 行命中（并发覆盖/状态已变化/版本不匹配），
      // 说明本次条件不再成立，继续往下走会用陈旧假设提交，必须放弃本轮处理交给后续任务。
      const uploadUpdate = await this.fileRepository.update(
        { id: fileId, uploadVersion, uploadStage: file.uploadStage },
        { uploadStage: 'uploading' } as Partial<File>,
      );
      if (uploadUpdate.affected === 0) {
        this.logger.warn(`文件 ${fileId} 升 uploading 条件未命中（并发变更），放弃本轮`);
        return;
      }
      file = await this.fileRepository.findOneOrFail({ where: { id: fileId } });

      try {
        let result = await this.loadReceipt(filePath, uploadVersion);
        if (!result) {
          result = await this.telegramService.uploadFile(
            createReadStream(filePath),
            file.originalName,
            undefined,
            file.size,
          );
          // DB 提交失败前先原子保存回执，Bull 重试/进程重启可直接恢复提交。
          await this.persistReceipt(filePath, result, uploadVersion);
        }
        // 回执（含历史/陈旧回执）必须包含非空 file_id，否则视为提交失败，
        // 避免把空引用写入 DB 造成“假成功”。
        if (!result?.file_id || !String(result.file_id).trim()) {
          throw new Error('Telegram 远端回执缺少有效 file_id，无法完成提交');
        }
        // 远端结果是幂等提交点：一次原子更新同时写入 TG 引用、清空历史失败原因并置 remote_committed。
        // G3-13：校验 affected，若 0 行命中（并发覆盖导致 uploadVersion 已变），不得把旧版本内容覆盖到新记录上。
        const commitUpdate = await this.fileRepository.update(
          { id: fileId, uploadVersion },
          {
            filename: result.file_id,
            telegramFileId: result.file_id,
            telegramFilePath: result.file_path || '',
            uploadStage: 'remote_committed',
            uploadFailureReason: null,
          } as Partial<File>,
        );
        if (commitUpdate.affected === 0) {
          this.logger.warn(`文件 ${fileId} 远端提交条件未命中（版本已变更），放弃本轮提交`);
          throw new Error('远端提交条件未命中（uploadVersion 已变更）');
        }
      } catch (error) {
        this.logger.warn(`文件远端上传或提交失败 (fileId=${fileId}, 第 ${attempt} 次): ${(error as Error).message}`);
        const remoteReceipt = await this.loadReceipt(filePath, uploadVersion);
        if (job.attemptsMade >= 2 && !remoteReceipt) {
          await this.fileRepository.update(
            { id: fileId, uploadVersion },
            {
              status: 'error',
              uploadStage: 'failed',
              uploadFailureReason: this.safeFailureReason((error as Error).message || '远端上传/提交失败', filePath),
            } as Partial<File>,
          );
          this.logger.warn(
            `文件上传最终失败并标记 error: fileId=${fileId} uploadVersion=${uploadVersion} 原因=远端上传/提交重试耗尽，无远端回执`,
          );
          await this.removeUploadArtifacts(filePath);
        } else if (job.attemptsMade >= 2 && remoteReceipt) {
          // G3-14：远端已成功（有回执）但 DB 提交失败且重试耗尽。回执无人消费会导致内容已上传、
          // 引用却写不进 DB。标记 recoverable 状态并保留本地文件/回执，由恢复任务凭回执提交，
          // 避免逼用户整文件重传。
          await this.fileRepository.update(
            { id: fileId, uploadVersion },
            {
              uploadStage: 'recoverable',
              uploadFailureReason: this.safeFailureReason((error as Error).message || '远端已提交但 DB 写入失败，等待恢复', filePath),
            } as Partial<File>,
          );
          this.logger.warn(
            `文件上传标记 recoverable（有远端回执但提交失败）: fileId=${fileId} uploadVersion=${uploadVersion}，交由恢复任务凭回执提交`,
          );
        }
        // 已有远端回执时必须保留本地文件/回执，后续以相同确定性 jobId 恢复 DB 提交。
        throw error;
      }
    }

    // 重新读取提交点，进程在 Telegram 成功后重启时会直接从这里恢复，绝不再次上传原文件。
    file = await this.fileRepository.findOneOrFail({ where: { id: fileId } });
    if (file.uploadVersion !== uploadVersion || !this.isCommitted(file)) return;

    // 收紧 ready 置位：必须有非空 telegramFileId，防止“假成功”死链进入 ready。
    // 缺少有效远端引用时不得置 ready，而是条件更新标记 error（不覆盖并发新上传）。
    const remoteFileId = file.telegramFileId?.trim?.();
    if (!remoteFileId) {
      await this.fileRepository.update(
        { id: fileId, uploadVersion },
        {
          status: 'error',
          uploadStage: 'failed',
          uploadFailureReason: 'Telegram 远端提交缺少有效 file_id，已标记上传失败',
        } as Partial<File>,
      );
      this.logger.warn(
        `文件 ${fileId} 置 ready 前缺少 telegramFileId，已标记 error（禁止假成功）`,
      );
      await this.removeUploadArtifacts(filePath);
      return;
    }

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

    // 收尾最后一步才置 ready，避免 ThumbnailService 使用旧实体状态覆盖 ready。
    // 条件更新同时保护 uploadVersion 和当前状态，防止并发覆盖写入。
    const readyUpdate = await this.fileRepository.query(
      'UPDATE files SET status = $1, "uploadFailureReason" = NULL WHERE id = $2 AND status IN ($3, $4) AND "uploadVersion" = $5',
      ['ready', fileId, 'processing', 'error', uploadVersion],
    );
    if (readyUpdate?.rowCount === 0 || readyUpdate?.affected === 0) {
      this.logger.warn(`文件 ${fileId} 置 ready 条件未命中（状态或版本已变化），跳过本轮收尾`);
      return;
    }

    await this.removeUploadArtifacts(filePath);
    this.logger.log(`文件上传完成: ${fileId}`);
  }
}
