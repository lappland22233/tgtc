import { Injectable } from '@nestjs/common';
import * as path from 'path';

/**
 * Bot 异步转存临时文件租约/追踪服务。
 *
 * 解决问题：
 * 当 Bot 接收到大文件并向 Google 云端硬盘转存时，本地缓冲文件（`tmp/bot-transfers/*.tmp`）
 * 在流式上传期间（可能耗时超过 2 小时）其 mtime 并不会刷新。
 * 后台定时孤儿清理（TasksService.cleanupOrphanBotTransferFiles）若仅根据 mtime > 2h
 * 判断，会误删仍在活跃上传中的源文件，导致后续账号故障转移（Failover 重新 openStream）
 * 遭遇 ENOENT 崩溃。
 *
 * 本服务在内存中追踪所有当前处于活跃状态的临时转存路径，供清理任务判定排除。
 */
@Injectable()
export class BotTransferTrackerService {
  private readonly activeFiles = new Set<string>();

  /**
   * 注册活跃转存临时文件，返回释放租约的回调函数。
   */
  register(filePath: string): () => void {
    const normalized = path.resolve(filePath);
    this.activeFiles.add(normalized);
    let released = false;
    return () => {
      if (!released) {
        released = true;
        this.activeFiles.delete(normalized);
      }
    };
  }

  /**
   * 检查指定临时文件是否正由活跃转存任务持有。
   */
  isTransferActive(filePath: string): boolean {
    const normalized = path.resolve(filePath);
    return this.activeFiles.has(normalized);
  }

  /**
   * 当前活跃转存任务数。
   */
  getActiveCount(): number {
    return this.activeFiles.size;
  }
}
