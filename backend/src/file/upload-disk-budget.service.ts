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

/** 租约被占导致的 429：只有持有超过该时长才值得记录（正常排队是秒级）。 */
const LEASE_BUSY_LOG_MIN_HOLD_MS = 60 * 1000;
/** 同一租约 key 的阻塞日志限频间隔，避免前端排队轮询把日志刷满。 */
const LEASE_BUSY_LOG_INTERVAL_MS = 60 * 1000;

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
  /** 阻塞日志限频状态：单槽租约只需记住上一次的 key 与时间，避免长期运行的 Map 增长。 */
  private lastBusyLogKey: string | null = null;
  private lastBusyLogAt = 0;

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
    if (this.activeLease) this.throwBusyForLease();

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
    if (this.activeLease) this.throwBusyForLease();
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

    if (this.activeLease) this.throwBusyForLease();
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

  /** 释放会话租约；返回是否真正命中（key 不匹配或已释放时为 false，幂等）。 */
  releaseSession(uploadId: string): boolean {
    return this.release(this.sessionKey(uploadId));
  }

  /** 释放 Worker 任务租约；返回是否真正命中（key 不匹配或已释放时为 false，幂等）。 */
  releaseJob(fileId: string, uploadVersion: number): boolean {
    return this.release(this.jobKey(fileId, uploadVersion));
  }

  hasActiveLease(): boolean {
    return this.activeLease !== null;
  }

  /** 只读租约快照：供日志与测试定位「谁占着上传通道、占了多久」。 */
  describeActiveLease(): { key: string; fileSize: number; heldMs: number } | null {
    if (!this.activeLease) return null;
    return {
      key: this.activeLease.key,
      fileSize: this.activeLease.fileSize,
      heldMs: Math.max(0, Date.now() - this.activeLease.acquiredAt),
    };
  }

  private release(key: string): boolean {
    if (!this.activeLease || this.activeLease.key !== key) return false;
    this.activeLease = null;
    return true;
  }

  /**
   * 租约被占：按需记录持有者与持有时间后再抛 429。
   *
   * 正常排队只有秒级，只有长时间占用才值得告警；同一 key 每 60s 最多一条，
   * 避免前端 5s 一次的排队轮询把日志刷满。
   */
  private throwBusyForLease(): never {
    const lease = this.describeActiveLease();
    if (lease && lease.heldMs >= LEASE_BUSY_LOG_MIN_HOLD_MS) {
      const now = Date.now();
      if (this.lastBusyLogKey !== lease.key || now - this.lastBusyLogAt >= LEASE_BUSY_LOG_INTERVAL_MS) {
        this.lastBusyLogKey = lease.key;
        this.lastBusyLogAt = now;
        this.logger.warn(
          `严格上传预算被占用: key=${lease.key}, fileSize=${lease.fileSize}, heldMs=${lease.heldMs}`,
        );
      }
    }
    throw this.createBusyException();
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
        // 业务码：全局过滤器与前端错误映射读取该字段（保持与下载资源协调器一致的结构）。
        code: 'UPLOAD_DISK_BUDGET_BUSY',
        errorCode: 'UPLOAD_DISK_BUDGET_BUSY',
        retryAfterMs: 5000,
        message: '服务器正在依次处理另一份大文件，本文件已自动排队，请保持页面打开',
      },
      HttpStatus.TOO_MANY_REQUESTS,
    );
  }
}
