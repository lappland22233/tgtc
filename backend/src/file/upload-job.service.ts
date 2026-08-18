import { Injectable, Logger, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, Brackets } from 'typeorm';
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
  /** G3-09：启动时仅标记超过此时间未更新的 pending/uploading 任务，避免误伤多副本在途任务 */
  private static readonly STARTUP_STALE_MS = 10 * 60 * 1000;
  /** 内存缓存：热路径查询，避免每次状态轮询都查库 */
  private jobs = new Map<string, UploadJob>();
  /** 每个 job 的串行持久化链，保证同一 job 的写入按调用顺序落库，避免并发乱序导致状态回退 */
  private writeChains = new Map<string, Promise<void>>();
  private cleanupTimer: ReturnType<typeof setInterval> | null = null;

  constructor(
    @InjectRepository(UploadTask)
    private uploadTaskRepo: Repository<UploadTask>,
  ) {}

  /**
   * 模块初始化时恢复未完成的任务，标记为失败。
   * G3-09：不把启动时所有 pending/uploading 直接标失败——多副本滚动部署时，
   * 在途任务可能属于其他存活实例，全部标失败会误伤。仅标记"已陈旧"（超过
   * STARTUP_STALE_MS 未更新）的任务，短时间内的在途任务保留不动。
   */
  async onModuleInit() {
    const staleCutoff = new Date(Date.now() - UploadJobService.STARTUP_STALE_MS);
    const staleTasks = await this.uploadTaskRepo
      .createQueryBuilder('task')
      .where('task.status IN (:...statuses)', { statuses: ['pending', 'uploading'] })
      .andWhere('task."updatedAt" < :cutoff', { cutoff: staleCutoff })
      .getMany();

    if (staleTasks.length > 0) {
      this.logger.warn(`发现 ${staleTasks.length} 个陈旧的未完成任务（>${Math.round(UploadJobService.STARTUP_STALE_MS / 60000)}分钟），标记为失败`);
      for (const task of staleTasks) {
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
   * G3-10：直接按 SQL 条件从库中删除（updatedAt < cutoff），不再只遍历内存 Map。
   * 这样重启后从未载入内存的更早历史 completed/failed 记录也能被清理，表不无限膨胀。
   * 同时同步清理内存缓存。
   */
  async cleanup(): Promise<void> {
    const now = Date.now();
    const completedCutoff = new Date(now - 30 * 60 * 1000);
    const stuckCutoff = new Date(now - 60 * 60 * 1000);

    const result = await this.uploadTaskRepo
      .createQueryBuilder()
      .delete()
      .from(UploadTask)
      .where(
        new Brackets((qb) => {
          qb.where('(status IN (:...done) AND "updatedAt" < :completedCutoff)', {
            done: ['completed', 'failed'],
            completedCutoff,
          }).orWhere('(status IN (:...stuck) AND "updatedAt" < :stuckCutoff)', {
            stuck: ['pending', 'uploading'],
            stuckCutoff,
          });
        }),
      )
      .execute();

    const deletedCount = result.affected ?? 0;
    if (deletedCount > 0) {
      this.logger.log(`清理过期上传任务 ${deletedCount} 条（数据库直删）`);
    }

    // 同步清理内存缓存与写链，避免与 DB 不一致
    for (const [id, job] of this.jobs) {
      const updated = job.updatedAt.getTime();
      if ((job.status === 'completed' || job.status === 'failed') && updated < completedCutoff.getTime()) {
        this.jobs.delete(id);
        this.writeChains.delete(id);
      } else if ((job.status === 'pending' || job.status === 'uploading') && updated < stuckCutoff.getTime()) {
        this.logger.warn(`清理卡住的上传任务 ${id}: ${job.filename} (状态: ${job.status})`);
        this.jobs.delete(id);
        this.writeChains.delete(id);
      }
    }
  }

  /**
   * 将内存中的任务状态持久化到数据库。
   * 通过 per-job 写入链串行化，保证同一任务的多次更新按顺序落库，
   * 避免高频 fire-and-forget upsert 并发乱序导致状态回退。
   */
  private saveToDatabase(job: UploadJob): Promise<void> {
    const prev = this.writeChains.get(job.jobId) || Promise.resolve();
    const next = prev
      .catch(() => {})
      .then(() =>
        this.uploadTaskRepo.upsert(
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
        ),
      )
      .then(() => undefined);
    // 链空闲时清理引用，避免 Map 泄漏
    void next.finally(() => {
      if (this.writeChains.get(job.jobId) === next) {
        this.writeChains.delete(job.jobId);
      }
    });
    this.writeChains.set(job.jobId, next);
    return next;
  }

  /**
   * 从数据库实体转换为内存 Job 对象
   * G3-11：result JSON.parse 包 try/catch，避免一行坏数据导致整个启动/恢复失败。
   */
  private toUploadJob(task: UploadTask): UploadJob {
    let result: UploadJob['result'];
    if (task.result) {
      try {
        result = JSON.parse(task.result);
      } catch {
        result = undefined;
        this.logger.warn(`上传任务 ${task.jobId} 的 result 字段不是合法 JSON，已忽略该结果`);
      }
    }
    return {
      jobId: task.jobId,
      userId: task.userId,
      filename: task.filename,
      status: task.status,
      progress: task.progress,
      result,
      error: task.error || undefined,
      createdAt: task.createdAt,
      updatedAt: task.updatedAt,
    };
  }
}
