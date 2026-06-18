import { Injectable, Logger, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { v4 as uuidv4 } from 'uuid';
import { User } from '../common/entities/user.entity';

export interface UploadJob {
  jobId: string;
  userId: string;
  filename: string;
  status: 'pending' | 'uploading' | 'completed' | 'failed';
  progress: number; // 0-100
  result?: any;     // 成功后返回的 File 实体
  error?: string;
  createdAt: Date;
  updatedAt: Date;
}

@Injectable()
export class UploadJobService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(UploadJobService.name);
  private jobs = new Map<string, UploadJob>();
  private cleanupTimer: ReturnType<typeof setInterval> | null = null;

  onModuleInit() {
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
    this.jobs.set(job.jobId, job);
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
    }
  }

  /**
   * 清理过期任务：
   * - 超过 30 分钟的已完成/失败任务
   * - 超过 60 分钟的 pending/uploading 任务（进程异常退出卡住的任务）
   */
  cleanup() {
    const completedCutoff = Date.now() - 30 * 60 * 1000;
    const stuckCutoff = Date.now() - 60 * 60 * 1000;
    for (const [id, job] of this.jobs) {
      const updated = job.updatedAt.getTime();
      if ((job.status === 'completed' || job.status === 'failed') && updated < completedCutoff) {
        this.jobs.delete(id);
      }
      if ((job.status === 'pending' || job.status === 'uploading') && updated < stuckCutoff) {
        this.logger.warn(`清理卡住的上传任务 ${id}: ${job.filename} (状态: ${job.status})`);
        this.jobs.delete(id);
      }
    }
  }
}
