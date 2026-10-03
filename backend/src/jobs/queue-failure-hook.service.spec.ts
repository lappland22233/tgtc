import { QUEUE_NAMES } from './bull-queue.module';
import { QueueFailureHookService } from './queue-failure-hook.service';

/**
 * 硬编码的队列清单：与 QUEUE_NAMES 完全一致（顺序也一致）。
 * 一旦 QUEUE_NAMES 增删/改名而本清单未同步，两个断言都会失败，
 * 提醒把新队列纳入失败钩子的覆盖范围与测试（防止漏挂）。
 */
const EXPECTED_QUEUE_NAMES = [
  'metrics-aggregation',
  'attack-detection',
  'alert-evaluation',
  'baseline-calculation',
  'data-archival',
  'file-upload',
  'file-verify',
  'telegram-mirror',
];

type MockQueue = { name: string; on: jest.Mock };

function makeQueues(): MockQueue[] {
  return EXPECTED_QUEUE_NAMES.map((name) => ({ name, on: jest.fn() }));
}

function getFailedHandler(queue: MockQueue): (job: unknown, error: unknown) => void {
  const failedCall = queue.on.mock.calls.find(([event]) => event === 'failed');
  if (!failedCall) {
    throw new Error(`队列 ${queue.name} 未注册 failed 监听`);
  }
  return failedCall[1] as (job: unknown, error: unknown) => void;
}

describe('QueueFailureHookService（PERF-B-105 / OPS-006）', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('为全部 8 个队列各注册一次 failed 监听，且队列清单与 QUEUE_NAMES 完全一致', () => {
    // 防止「注册了队列但失败钩子漏挂」：清单必须与单一事实来源 QUEUE_NAMES 相同
    expect(Object.values(QUEUE_NAMES)).toEqual(EXPECTED_QUEUE_NAMES);

    const queues = makeQueues();
    const service = new QueueFailureHookService(queues as any);
    service.onModuleInit();

    for (const queue of queues) {
      expect(queue.on).toHaveBeenCalledTimes(1);
      expect(queue.on).toHaveBeenCalledWith('failed', expect.any(Function));
    }
  });

  it('失败回调只记录 queue/jobId/job 名/尝试次数/错误摘要，绝不输出 job.data 全文', () => {
    const queues = makeQueues();
    const service = new QueueFailureHookService(queues as any);
    const errorSpy = jest
      .spyOn((service as any).logger, 'error')
      .mockImplementation(() => undefined as any);
    service.onModuleInit();

    const handler = getFailedHandler(queues[0]); // metrics-aggregation
    handler(
      {
        id: 'job-42',
        name: 'aggregate-1min',
        attemptsMade: 2,
        data: {
          fileId: 'file-secret-id',
          token: 'token-secret-value',
          payload: 'secret-payload',
        },
      },
      new Error('upstream timeout'),
    );

    expect(errorSpy).toHaveBeenCalledTimes(1);
    const message = String(errorSpy.mock.calls[0][0]);
    expect(message).toContain('queue=metrics-aggregation');
    expect(message).toContain('jobId=job-42');
    expect(message).toContain('name=aggregate-1min');
    expect(message).toContain('attemptsMade=2');
    expect(message).toContain('error=upstream timeout');
    // job.data 中的敏感字段不得出现在日志中
    expect(message).not.toContain('file-secret-id');
    expect(message).not.toContain('token-secret-value');
    expect(message).not.toContain('secret-payload');
  });

  it('错误摘要单行化（去换行/制表符）并截断到 300 字符', () => {
    const queues = makeQueues();
    const service = new QueueFailureHookService(queues as any);
    const errorSpy = jest
      .spyOn((service as any).logger, 'error')
      .mockImplementation(() => undefined as any);
    service.onModuleInit();

    const handler = getFailedHandler(queues[1]); // attack-detection

    handler(
      { id: 'job-1', name: 'detect-attacks', attemptsMade: 1 },
      new Error('line1\nline2\r\nline3\tend'),
    );
    const singleLineMessage = String(errorSpy.mock.calls[0][0]);
    expect(singleLineMessage).not.toMatch(/[\r\n\t]/);
    expect(singleLineMessage).toContain('error=line1 line2 line3 end');

    handler(
      { id: 'job-2', name: 'detect-attacks', attemptsMade: 2 },
      new Error('a'.repeat(500)),
    );
    const truncatedMessage = String(errorSpy.mock.calls[1][0]);
    expect(truncatedMessage).toContain(`error=${'a'.repeat(300)}`);
    expect(truncatedMessage).not.toContain('a'.repeat(301));

    // 非 Error 抛出品也能安全收敛为字符串摘要
    handler({ id: 'job-3', name: 'detect-attacks', attemptsMade: 3 }, 'plain-string failure');
    expect(String(errorSpy.mock.calls[2][0])).toContain('error=plain-string failure');
  });

  it('每个队列的回调绑定自身队列名（以 telegram-mirror 为例）', () => {
    const queues = makeQueues();
    const service = new QueueFailureHookService(queues as any);
    const errorSpy = jest
      .spyOn((service as any).logger, 'error')
      .mockImplementation(() => undefined as any);
    service.onModuleInit();

    const handler = getFailedHandler(queues[7]); // telegram-mirror
    handler({ id: 'job-9', name: 'mirror', attemptsMade: 1 }, new Error('relay failed'));

    const message = String(errorSpy.mock.calls[0][0]);
    expect(message).toContain('queue=telegram-mirror');
    expect(message).toContain('jobId=job-9');
    expect(message).toContain('name=mirror');
  });
});
