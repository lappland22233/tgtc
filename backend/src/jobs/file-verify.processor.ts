import { Injectable } from '@nestjs/common';
import { Process, Processor } from '@nestjs/bull';
import { Job } from 'bull';
import { QUEUE_NAMES } from './bull-queue.module';
import { FileVerifyService } from '../admin/file-verify.service';

@Injectable()
@Processor(QUEUE_NAMES.FILE_VERIFY)
export class FileVerifyProcessor {
  constructor(private fileVerifyService: FileVerifyService) {}

  @Process({ name: 'verify', concurrency: 1 }) // 必须 concurrency:1，全局单任务
  async handleVerify(job: Job<{ taskId: string }>): Promise<void> {
    const { taskId } = job.data;
    try {
      await this.fileVerifyService.runVerification(taskId);
    } catch (error) {
      // 未预期的异常（DB 故障等）：标记失败并释放槽位，避免任务永久卡在 running
      await this.fileVerifyService.markFailed(taskId, error);
      throw error; // 仍向 Bull 报告失败便于排查
    }
  }
}
