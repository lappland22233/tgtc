import { AuditService } from './audit.service';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const entry = { action: 'role_change' as const, userId: 'u1', metadata: { from: 'admin', to: 'user' } };

/** 微任务冲刷：不依赖定时器，确定性地推进挂起的 Promise 链。 */
const flushMicrotasks = async () => {
  for (let i = 0; i < 20; i++) {
    await Promise.resolve();
  }
};

describe('AuditService.logAwait (G8-07)', () => {
  let originalEnv: NodeJS.ProcessEnv;
  let degradedDir: string;

  beforeEach(async () => {
    originalEnv = process.env;
    // 每个用例使用独立临时目录；必须在服务实例化前设置（degradedDir 在构造时读取）
    degradedDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'tgtc-audit-test-'));
    process.env.AUDIT_DEGRADED_DIR = degradedDir;
  });

  afterEach(async () => {
    delete process.env.AUDIT_DEGRADED_DIR;
    process.env = originalEnv;
    await fs.promises.rm(degradedDir, { recursive: true, force: true });
  });

  function buildAuditService(configCache: any = { get: jest.fn(async () => 'false') }) {
    const auditLogRepository = { create: jest.fn(), save: jest.fn() };
    const service = new AuditService(auditLogRepository as any, configCache);
    return { service, auditLogRepository, configCache };
  }

  /** 读取降级 NDJSON 记录（按文件名匹配，不依赖目录内任意首个文件）。 */
  function readDegradedRecords(): Array<{ ts: string; reason: string; entry: Record<string, unknown> }> {
    const files = fs
      .readdirSync(degradedDir)
      .filter((name) => /^audit-\d{4}-\d{2}-\d{2}\.ndjson$/.test(name));
    expect(files.length).toBeGreaterThan(0);
    return files.flatMap((name) =>
      fs
        .readFileSync(path.join(degradedDir, name), 'utf8')
        .split('\n')
        .filter((line) => line.length > 0)
        .map((line) => JSON.parse(line)),
    );
  }

  it('写入成功时不产生降级文件也不抛错', async () => {
    const { service, auditLogRepository } = buildAuditService();
    auditLogRepository.save.mockResolvedValue({});

    await expect(service.logAwait(entry)).resolves.toBeUndefined();
    expect(auditLogRepository.save).toHaveBeenCalledTimes(1);
    expect(fs.readdirSync(degradedDir)).toHaveLength(0);
  });

  it('重试耗尽后等待降级文件写入完成再返回（默认 failFast 关闭时不抛出）', async () => {
    const { service, auditLogRepository } = buildAuditService();
    auditLogRepository.save.mockRejectedValue(new Error('DB down'));

    await expect(service.logAwait(entry)).resolves.toBeUndefined();
    expect(auditLogRepository.save).toHaveBeenCalledTimes(3); // 重试 3 次

    // 等待链修复后返回即代表写入完成：记录完整且可解析
    const records = readDegradedRecords();
    expect(records).toHaveLength(1);
    expect(records[0].entry.action).toBe('role_change');
    expect(records[0].entry.metadata).toEqual({ from: 'admin', to: 'user' });
    expect(records[0].reason).toContain('DB down');
  });

  it('降级写入未完成前不返回，也不提前查询 failFast 开关（等待链回归）', async () => {
    jest.useFakeTimers();
    const pendingAppends: Array<{ resolve: () => void; reject: (error: Error) => void }> = [];
    const appendSpy = jest
      .spyOn(fs.promises, 'appendFile')
      .mockImplementation(
        () => new Promise<void>((resolve, reject) => pendingAppends.push({ resolve, reject })),
      );
    try {
      const { service, auditLogRepository, configCache } = buildAuditService();
      auditLogRepository.save.mockRejectedValue(new Error('DB down'));

      let settled = false;
      const pending = service.logAwait(entry).then(() => {
        settled = true;
      });

      // 推进真实重试退避间隔（logAwait 默认 3 次重试，100ms + 200ms），耗尽后进入降级写入
      const retryBackoffTotalMs = 100 + 200;
      await jest.advanceTimersByTimeAsync(retryBackoffTotalMs);
      await flushMicrotasks();
      expect(auditLogRepository.save).toHaveBeenCalledTimes(3);
      expect(pendingAppends).toHaveLength(1);

      // appendFile 未 resolve 前，logAwait 不结束，且不查询 failFast 开关
      await flushMicrotasks();
      expect(settled).toBe(false);
      expect(configCache.get).not.toHaveBeenCalledWith('AUDIT_FAIL_FAST');

      // 写入完成后才继续执行 failFast 判断并返回
      pendingAppends[0].resolve();
      await pending;
      expect(settled).toBe(true);
      expect(configCache.get).toHaveBeenCalledWith('AUDIT_FAIL_FAST', 'false');
    } finally {
      appendSpy.mockRestore();
      jest.useRealTimers();
    }
  });

  it('降级写入失败时记录错误且默认不抛出', async () => {
    const appendSpy = jest.spyOn(fs.promises, 'appendFile').mockRejectedValue(new Error('disk full'));
    try {
      const { service, auditLogRepository } = buildAuditService();
      const loggerSpy = jest
        .spyOn((service as any).logger, 'error')
        .mockImplementation(() => {});
      auditLogRepository.save.mockRejectedValue(new Error('DB down'));

      await expect(service.logAwait(entry)).resolves.toBeUndefined();
      expect(loggerSpy).toHaveBeenCalledWith(expect.stringContaining('审计降级文件写入失败'));
      expect(loggerSpy).toHaveBeenCalledWith(expect.stringContaining('disk full'));
    } finally {
      appendSpy.mockRestore();
    }
  });

  it('开启 AUDIT_FAIL_FAST 时，重试耗尽后抛出（审计失败即操作失败）', async () => {
    const configCache = {
      get: jest.fn(async (k: string) => (k === 'AUDIT_FAIL_FAST' ? 'true' : 'false')),
    };
    const { service, auditLogRepository } = buildAuditService(configCache);
    auditLogRepository.save.mockRejectedValue(new Error('DB down'));

    await expect(service.logAwait(entry)).rejects.toThrow('高敏审计写入失败');
  });
});
