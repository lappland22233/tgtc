import { DownloadAdmissionService, AdmissionRejection, DOWNLOAD_ADMISSION_LIMITS } from './download-admission.service';

// 生产代码通过 require('fs').statfsSync 读取，Jest 中与 import 指向同一 module 对象，
// 因此用 require('fs') 来 spy。
const fsModule = require('fs');

function mockFree(bytes: number): void {
  jest.spyOn(fsModule, 'statfsSync').mockReturnValue({
    bsize: 4096,
    bfree: Math.ceil(bytes / 4096),
    bavail: Math.ceil(bytes / 4096),
  } as ReturnType<typeof fsModule.statfsSync>);
}

describe('DownloadAdmissionService', () => {
  let service: DownloadAdmissionService;

  beforeEach(() => {
    jest.restoreAllMocks();
    service = new DownloadAdmissionService();
    service.setProbeDir('/tmp/fake-cache-dir');
  });

  afterEach(() => {
    service.shutdown();
  });

  it('空间充足时立即准入并登记预约', async () => {
    mockFree(1024 * 1024);
    const ticket = await service.admit(1024, 512 * 1024);
    await ticket.done;
    expect(service.pendingReservedBytes).toBe(1024);
    expect(service.waitingCount).toBe(0);
  });

  it('空间不足时进入等待队列，释放后按 FIFO 唤醒', async () => {
    mockFree(1024 * 1024);
    const minFree = 512 * 1024;
    // 占用第一个会话的额度：空闲 1MB - 余量 0.5MB = 0.5MB 可用
    const t1 = await service.admit(512 * 1024, minFree);
    await t1.done;
    // 第二个会话 0.5MB：空闲 - 余量 - 预约 = 0，不足 → 排队
    const t2 = service.admit(512 * 1024, minFree);
    // 等待队列应有 1 项（未 resolve）
    await Promise.resolve();
    expect(service.waitingCount).toBe(1);
    // 第一个会话完成释放 → 队头被唤醒
    service.release(512 * 1024, minFree);
    await expect(t2).resolves.toBeDefined();
    expect(service.waitingCount).toBe(0);
  });

  it('预约记账：会话结束全额归还（P1-09 回归：完整下载后预约归零）', async () => {
    mockFree(1024 * 1024);
    const minFree = 0;
    const t1 = await service.admit(1024, minFree);
    await t1.done;
    expect(service.pendingReservedBytes).toBe(1024);
    // 提前中止（写入 600 字节）→ 仍全额归还，物理占用由 statfs 反映
    service.release(1024, minFree);
    expect(service.pendingReservedBytes).toBe(0);

    // 完整下载（written == admitted）：归还后预约必须归零，不得累积
    const t2 = await service.admit(1024, minFree);
    await t2.done;
    expect(service.pendingReservedBytes).toBe(1024);
    service.release(1024, minFree);
    expect(service.pendingReservedBytes).toBe(0);
  });

  it('单会话超过可用空间时立即拒绝（CAPACITY_EXCEEDED）', async () => {
    mockFree(1024 * 1024);
    const minFree = 512 * 1024;
    // 需要 2MB，空闲 1MB 即使不扣余量也容纳不了 → 不排队，直接拒绝
    await expect(service.admit(2 * 1024 * 1024, minFree)).rejects.toMatchObject({
      admissionReason: AdmissionRejection.CAPACITY_EXCEEDED,
    });
    expect(service.waitingCount).toBe(0);
  });

  it('statfs 失败时按探测不可用拒绝（PROBE_UNAVAILABLE）', async () => {
    jest.spyOn(fsModule, 'statfsSync').mockImplementation(() => {
      throw new Error('EACCES');
    });
    await expect(service.admit(1024, 0)).rejects.toMatchObject({
      admissionReason: AdmissionRejection.PROBE_UNAVAILABLE,
    });
  });

  it('等待队列有界：超过 MAX_WAITING 拒绝新等待项', async () => {
    mockFree(1024 * 1024);
    const minFree = 0;
    // 先占满全部额度，后续请求只入队（空闲-余量 >= 1 字节，不会触发硬拒绝）
    const first = await service.admit(1024 * 1024, minFree);
    await first.done;
    const tickets: Promise<unknown>[] = [];
    for (let i = 0; i < DOWNLOAD_ADMISSION_LIMITS.MAX_WAITING; i++) {
      tickets.push(service.admit(1, minFree).then(t => t.done));
    }
    await Promise.resolve();
    expect(service.waitingCount).toBe(DOWNLOAD_ADMISSION_LIMITS.MAX_WAITING);
    await expect(service.admit(1, minFree)).rejects.toMatchObject({
      admissionReason: AdmissionRejection.CAPACITY_EXCEEDED,
    });
    // 清理：拒绝全部等待项
    service.shutdown();
    await Promise.allSettled(tickets);
  });

  it('超时后以超时错误移除等待项', async () => {
    jest.useFakeTimers();
    mockFree(1024 * 1024);
    const minFree = 0;
    // 占满额度迫使后续请求排队
    const first = service.admit(1024 * 1024, minFree);
    await first.then(t => t.done);
    const p = service.admit(1, minFree, { waitTimeoutMs: 100 });
    const expectation = expect(p).rejects.toThrow('下载等待空间超时');
    await jest.advanceTimersByTimeAsync(150);
    await expectation;
    expect(service.waitingCount).toBe(0);
    jest.useRealTimers();
  });

  it('shutdown 拒绝所有等待项', async () => {
    mockFree(1024 * 1024);
    const minFree = 0;
    const first = service.admit(1024 * 1024, minFree);
    await first.then(t => t.done);
    const p = service.admit(1, minFree);
    await Promise.resolve();
    expect(service.waitingCount).toBe(1);
    service.shutdown();
    await expect(p).rejects.toThrow('系统正在关闭');
    expect(service.waitingCount).toBe(0);
  });

  it('释放后唤醒遵循 FIFO，队头未满足时不跳过（防饥饿）', async () => {
    mockFree(1024 * 1024);
    const minFree = 0;
    // 预约占满 1MB
    const t1 = await service.admit(1024 * 1024, minFree);
    await t1.done;
    // 队头需要 2MB（暂时无法满足），队尾只需 1 字节
    const head = service.admit(2 * 1024 * 1024, minFree, { rejectIfUnsatisfiable: false });
    const tail = service.admit(1, minFree);
    await Promise.resolve();
    expect(service.waitingCount).toBe(2);
    // 释放 1MB：队头 2MB 仍不满足（空闲 1MB < 2MB），队尾不跳过
    service.release(1024 * 1024, minFree);
    await Promise.resolve();
    expect(service.waitingCount).toBe(2);
    // shutdown 清理两个等待项
    service.shutdown();
    await expect(head).rejects.toThrow('系统正在关闭');
    await expect(tail).rejects.toThrow('系统正在关闭');
  });
});
