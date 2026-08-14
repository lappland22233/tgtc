import { FileVerifyProcessor } from './file-verify.processor';

function makeProcessor(runVerification: jest.Mock, markFailed: jest.Mock) {
  const fileVerifyService = { runVerification, markFailed } as any;
  return new FileVerifyProcessor(fileVerifyService);
}

function makeJob(taskId = 'task-1') {
  return { data: { taskId } } as any;
}

describe('FileVerifyProcessor', () => {
  beforeEach(() => jest.clearAllMocks());

  it('正常路径：runVerification resolve → processor 不抛错，markFailed 不被调用', async () => {
    const runVerification = jest.fn().mockResolvedValue(undefined);
    const markFailed = jest.fn();
    const processor = makeProcessor(runVerification, markFailed);

    await expect(processor.handleVerify(makeJob())).resolves.toBeUndefined();
    expect(runVerification).toHaveBeenCalledWith('task-1');
    expect(markFailed).not.toHaveBeenCalled();
  });

  it('异常路径：runVerification reject → markFailed 被调用且 processor 继续抛出', async () => {
    const boom = new Error('DB 故障');
    const runVerification = jest.fn().mockRejectedValue(boom);
    const markFailed = jest.fn().mockResolvedValue(undefined);
    const processor = makeProcessor(runVerification, markFailed);

    await expect(processor.handleVerify(makeJob('task-2'))).rejects.toBe(boom);
    expect(markFailed).toHaveBeenCalledWith('task-2', boom);
  });
});
