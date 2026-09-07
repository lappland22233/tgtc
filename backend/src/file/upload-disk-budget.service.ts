import { HttpException, HttpStatus, Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { promises as fsp } from 'fs';
import * as path from 'path';
import { In, Repository } from 'typeorm';
import { File } from '../common/entities/file.entity';
import { FileCacheService } from './file-cache.service';

interface UploadDiskLease {
  key: string;
  fileSize: number;
  acquiredAt: number;
}

const RECOVERABLE_UPLOAD_STAGES = ['pending', 'uploading', 'remote_committed', 'recoverable'] as const;

/**
 * 无缓存／小盘严格模式的进程内磁盘占用闸门。
 *
 * 它不替代文件系统可用空间检查：ChunkUploadService 在写入前仍负责校验 2S 与最小余量。
 * 此处只确保同一应用进程不会让两条完整文件生命周期同时占用临时空间；重启后会先
 * 检查数据库中的未完成上传，避免把恢复中的 pending 文件误当作可用空间。
 */
@Injectable()
export class UploadDiskBudgetService {
  private readonly logger = new Logger(UploadDiskBudgetService.name);
  private activeLease: UploadDiskLease | null = null;

  private readonly pendingDir = path.resolve(process.cwd(), 'tmp', 'uploads', 'pending');
  private readonly singleProcess: boolean;

  constructor(
    @InjectRepository(File)
    private readonly fileRepository: Repository<File>,
    private readonly fileCacheService: FileCacheService,
    configService: ConfigService,
  ) {
    // 进程内租约无法跨副本协调；现有部署默认为单后端进程，因此无缓存模式默认启用
    // 严格 2S 策略。多副本共享上传盘时必须显式设为 false，避免错误承诺全局预算。
    this.singleProcess = configService.get<string>('STRICT_UPLOAD_SINGLE_PROCESS') !== 'false';
  }

  isStrictMode(): boolean {
    return this.singleProcess && this.fileCacheService.isNoCacheMode();
  }

  async acquireSession(uploadId: string, fileSize: number): Promise<void> {
    if (!this.isStrictMode()) return;
    if (!Number.isSafeInteger(fileSize) || fileSize <= 0) {
      throw new HttpException('无法为非法文件大小分配上传磁盘预算', HttpStatus.BAD_REQUEST);
    }
    if (this.activeLease) throw this.createBusyException();

    let persistedActive: File | null;
    try {
      persistedActive = await this.fileRepository.findOne({
        where: {
          status: 'processing',
          uploadStage: In([...RECOVERABLE_UPLOAD_STAGES]),
        } as any,
        select: { id: true, uploadVersion: true },
      });
    } catch (error) {
      this.logger.error(`无法确认恢复中的上传任务，拒绝严格模式准入: ${(error as Error).message}`);
      throw new ServiceUnavailableException('无法确认上传磁盘预算，请稍后重试');
    }

    // await 数据库查询期间可能已有另一请求取得内存租约，重新检查避免竞争放行。
    if (this.activeLease) throw this.createBusyException();
    if (persistedActive) {
      this.logger.warn(
        `严格上传预算等待恢复任务: fileId=${persistedActive.id} version=${persistedActive.uploadVersion}`,
      );
      throw this.createBusyException();
    }

    // 数据库与文件系统任一方仍持有上传源都不能再放行。对于已标记失败／已删除或 DB
    // 无记录的 UUID 源，安全移除其残留文件和回执；其余不明文件保守阻塞，绝不猜测删除。
    try {
      const entries = await fsp.readdir(this.pendingDir, { withFileTypes: true });
      const sourceNames = entries
        .filter((entry) => entry.isFile()
          && !entry.name.endsWith('.telegram.json')
          && !entry.name.endsWith('.telegram.json.tmp'))
        .map((entry) => entry.name);
      const uuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
      for (const name of sourceNames) {
        if (!uuidRe.test(name)) {
          this.logger.warn('严格上传预算发现未知 pending 文件，拒绝新会话');
          throw this.createBusyException();
        }
        const file = await this.fileRepository.findOne({
          where: { id: name },
          withDeleted: true,
          select: { id: true, status: true, uploadStage: true },
        });
        const required = file?.status === 'processing'
          && RECOVERABLE_UPLOAD_STAGES.includes(file.uploadStage as typeof RECOVERABLE_UPLOAD_STAGES[number]);
        if (required) {
          this.logger.warn(`严格上传预算等待 pending 恢复源: fileId=${name}`);
          throw this.createBusyException();
        }
        await Promise.all([
          fsp.rm(path.join(this.pendingDir, name), { force: true }),
          fsp.rm(path.join(this.pendingDir, `${name}.telegram.json`), { force: true }),
          fsp.rm(path.join(this.pendingDir, `${name}.telegram.json.tmp`), { force: true }),
        ]);
      }
    } catch (error: any) {
      if (error instanceof HttpException) throw error;
      if (error?.code !== 'ENOENT') {
        this.logger.error(`无法检查 pending 上传源，拒绝严格模式准入: ${error?.message || '未知错误'}`);
        throw new ServiceUnavailableException('无法确认上传磁盘预算，请稍后重试');
      }
    }

    if (this.activeLease) throw this.createBusyException();
    this.activeLease = {
      key: this.sessionKey(uploadId),
      fileSize,
      acquiredAt: Date.now(),
    };
  }

  transferSessionToJob(uploadId: string, fileId: string, uploadVersion: number): boolean {
    // 严格状态在 ChunkSession 初始化时冻结；即使运行中关闭无缓存，也必须完成既有租约转交。
    const sessionKey = this.sessionKey(uploadId);
    if (!this.activeLease || this.activeLease.key !== sessionKey) {
      this.logger.error(`严格上传预算租约转移失败: session=${uploadId}, fileId=${fileId}`);
      return false;
    }
    this.activeLease.key = this.jobKey(fileId, uploadVersion);
    return true;
  }

  transferJobToSession(uploadId: string, fileId: string, uploadVersion: number): void {
    const jobKey = this.jobKey(fileId, uploadVersion);
    if (this.activeLease?.key === jobKey) this.activeLease.key = this.sessionKey(uploadId);
  }

  releaseSession(uploadId: string): void {
    this.release(this.sessionKey(uploadId));
  }

  releaseJob(fileId: string, uploadVersion: number): void {
    this.release(this.jobKey(fileId, uploadVersion));
  }

  hasActiveLease(): boolean {
    return this.activeLease !== null;
  }

  private release(key: string): void {
    if (!this.activeLease || this.activeLease.key !== key) return;
    this.activeLease = null;
  }

  private sessionKey(uploadId: string): string {
    return `session:${uploadId}`;
  }

  private jobKey(fileId: string, uploadVersion: number): string {
    return `job:${fileId}:${uploadVersion}`;
  }

  private createBusyException(): HttpException {
    return new HttpException(
      {
        statusCode: HttpStatus.TOO_MANY_REQUESTS,
        code: 'UPLOAD_DISK_BUDGET_BUSY',
        retryAfterMs: 5000,
        message: '服务器正在为另一份大文件保留磁盘空间，请保持本页打开后稍候重试',
      },
      HttpStatus.TOO_MANY_REQUESTS,
    );
  }
}
