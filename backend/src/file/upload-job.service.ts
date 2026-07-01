import { Injectable, Logger, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, In } from 'typeorm';
import { v4 as uuidv4 } from 'uuid';
import { User } from '../common/entities/user.entity';
import { File } from '../common/entities/file.entity';
import { UploadTask } from '../common/entities/upload-task.entity';

/** 单文件上传成功结果 */
export type SingleUploadResult = File;
/** 批量上传结果 */
export interface BatchUploadResult {
  success: File[];
  failed: { name: string; reason: string }[];
}

export interface UploadJob {
  jobId: string;
  userId: string;
  filename: string;
  status: 'pending' | 'uploading' | 'completed' | 'failed';
  progress: number; // 0-100
  // 单文件上传返回 File，批量上传返回 BatchUploadResult
  result?: SingleUploadResult | BatchUploadResult;
  error?: string;
  createdAt: Date;
  updatedAt: Date;
}

@Injectable()
export class UploadJobService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(UploadJobService.name);
  /** 内存缓存：热路径查询，避免每次状态轮询都查库 */
  private jobs = new Map<string, UploadJob>();
  private cleanupTimer: ReturnType<typeof setInterval> | null = null;

  constructor(
    @InjectRepository(UploadTask)
    private uploadTaskRepo: Repository<UploadTask>,
  ) {}

  /**
   * 模块初始化时恢复未完成的任务，标记为失败
   * 已完成的任务加载到内存缓存中
   */
  async onModuleInit() {
    const pendingTasks = await this.uploadTaskRepo.find({
      where: [
        { status: 'pending' },
        { status: 'uploading' },
      ],
    });

    if (pendingTasks.length > 0) {
      this.logger.warn(`发现 ${pendingTasks.length} 个未完成的上传任务，标记为失败`);
      for (const task of pendingTasks) {
        task.status = 'failed';
        task.error = '服务器进程重启，上传任务已丢失';
        await this.uploadTaskRepo.save(task);
      }
    }

    // 加载最近 30 分钟内的已完成/失败任务到内存缓存（支持轮询查询）
    const recentCutoff = new Date(Date.now() - 30 * 60 * 1000);
    const recentTasks = await this.uploadTaskRepo
      .createQueryBuilder('task')
      .where('task."updatedAt" > :cutoff', { cutoff: recentCutoff })
      .getMany();

    for (const task of recentTasks) {
      this.jobs.set(task.jobId, this.toUploadJob(task));
    }
    this.logger.log(`已从数据库恢复 ${recentTasks.length} 个近期任务记录`);

    // 每 5 分钟清理一次过期任务
    this.cleanupTimer = setInterval(() => this.cleanup(), 5 * 60 * 1000);
  }

  onModuleDestroy() {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
  }

  createJob(user: User, filename: string, fileCount: number = 1): UploadJob {
    const job: UploadJob = {
      jobId: uuidv4(),
      userId: user.id,
      filename: fileCount > 1 ? `${fileCount} 个文件` : filename,
      status: 'pending',
      progress: 0,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    // 写入内存缓存
    this.jobs.set(job.jobId, job);
    // 异步持久化到数据库（不阻塞主流程）
    this.saveToDatabase(job).catch((err) => {
      this.logger.warn(`创建上传任务持久化失败 (${job.jobId}): ${err.message}`);
    });
    this.logger.log(`创建上传任务 ${job.jobId}: ${job.filename}`);
    return job;
  }

  getJob(jobId: string): UploadJob | undefined {
    return this.jobs.get(jobId);
  }

  updateJob(jobId: string, update: Partial<Pick<UploadJob, 'status' | 'progress' | 'result' | 'error'>>) {
    const job = this.jobs.get(jobId);
    if (job) {
      Object.assign(job, update, { updatedAt: new Date() });
      this.logger.log(`上传任务 ${jobId}: ${job.status} (${job.progress}%)`);
      // 异步持久化
      this.saveToDatabase(job).catch((err) => {
        this.logger.warn(`更新上传任务持久化失败 (${jobId}): ${err.message}`);
      });
    }
  }

  /**
   * 清理过期任务：
   * - 超过 30 分钟的已完成/失败任务
   * - 超过 60 分钟的 pending/uploading 任务（进程异常退出卡住的任务）
   * 同时清理内存和数据库
   */
  async cleanup(): Promise<void> {
    const now = Date.now();
    const completedCutoff = now - 30 * 60 * 1000;
    const stuckCutoff = now - 60 * 60 * 1000;

    const idsToDelete: string[] = [];
    for (const [id, job] of this.jobs) {
      const updated = job.updatedAt.getTime();
      if ((job.status === 'completed' || job.status === 'failed') && updated < completedCutoff) {
        idsToDelete.push(id);
      }
      if ((job.status === 'pending' || job.status === 'uploading') && updated < stuckCutoff) {
        this.logger.warn(`清理卡住的上传任务 ${id}: ${job.filename} (状态: ${job.status})`);
        idsToDelete.push(id);
      }
    }

    for (const id of idsToDelete) {
      this.jobs.delete(id);
    }

    if (idsToDelete.length > 0) {
      await this.uploadTaskRepo.delete({ jobId: In(idsToDelete) });
    }
  }

  /**
   * 将内存中的任务状态持久化到数据库
   */
  private async saveToDatabase(job: UploadJob): Promise<void> {
    await this.uploadTaskRepo.upsert(
      {
        jobId: job.jobId,
        userId: job.userId,
        filename: job.filename,
        status: job.status,
        progress: job.progress,
        result: job.result ? JSON.stringify(job.result) : null,
        error: job.error || null,
      },
      ['jobId'],
    );
  }

  /**
   * 从数据库实体转换为内存 Job 对象
   */
  private toUploadJob(task: UploadTask): UploadJob {
    return {
      jobId: task.jobId,
      userId: task.userId,
      filename: task.filename,
      status: task.status,
      progress: task.progress,
      result: task.result ? JSON.parse(task.result) : undefined,
      error: task.error || undefined,
      createdAt: task.createdAt,
      updatedAt: task.updatedAt,
    };
  }
}
