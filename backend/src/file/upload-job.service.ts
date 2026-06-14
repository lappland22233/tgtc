import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
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
export class UploadJobService implements OnModuleInit {
  private readonly logger = new Logger(UploadJobService.name);
  private jobs = new Map<string, UploadJob>();

  onModuleInit() {
    // 每 5 分钟清理一次已完成/失败的过期任务
    setInterval(() => this.cleanup(), 5 * 60 * 1000);
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
   * 清理超过 30 分钟的已完成/失败任务
   */
  cleanup() {
    const cutoff = Date.now() - 30 * 60 * 1000;
    for (const [id, job] of this.jobs) {
      if ((job.status === 'completed' || job.status === 'failed') && job.updatedAt.getTime() < cutoff) {
        this.jobs.delete(id);
      }
    }
  }
}
