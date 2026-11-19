import { BotTransferTrackerService } from './bot-transfer-tracker.service';
import * as path from 'path';

describe('BotTransferTrackerService', () => {
  let tracker: BotTransferTrackerService;

  beforeEach(() => {
    tracker = new BotTransferTrackerService();
  });

  it('正确注册与释放活跃文件租约', () => {
    const filePath = path.resolve('tmp/bot-transfers/test-1.tmp');
    expect(tracker.isTransferActive(filePath)).toBe(false);
    expect(tracker.getActiveCount()).toBe(0);

    const release = tracker.register(filePath);
    expect(tracker.isTransferActive(filePath)).toBe(true);
    expect(tracker.getActiveCount()).toBe(1);

    // 相对路径也能匹配为绝对路径
    expect(tracker.isTransferActive('tmp/bot-transfers/test-1.tmp')).toBe(true);

    release();
    expect(tracker.isTransferActive(filePath)).toBe(false);
    expect(tracker.getActiveCount()).toBe(0);

    // 重复释放幂等
    release();
    expect(tracker.getActiveCount()).toBe(0);
  });
});
