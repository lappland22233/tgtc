import { AuditService } from './audit.service';
import * as fs from 'fs';

function buildAuditService(configCache: any = { get: jest.fn(async () => 'false') }) {
  const auditLogRepository = { create: jest.fn(), save: jest.fn() };
  const service = new AuditService(auditLogRepository as any, configCache);
  return { service, auditLogRepository, configCache };
}

const entry = { action: 'role_change' as const, userId: 'u1', metadata: { from: 'admin', to: 'user' } };

describe('AuditService.logAwait (G8-07)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    // 默认降级目录指向临时目录，避免污染工作区
    process.env.AUDIT_DEGRADED_DIR = require('path').join(require('os').tmpdir(), 'tgtc-audit-test');
  });

  it('写入成功时不产生降级文件也不抛错', async () => {
    const { service, auditLogRepository } = buildAuditService();
    auditLogRepository.save.mockResolvedValue({});

    await expect(service.logAwait(entry)).resolves.toBeUndefined();
    expect(auditLogRepository.save).toHaveBeenCalledTimes(1);
  });

  it('重试耗尽后写入本地降级文件（默认 failFast 关闭时不抛出）', async () => {
    const { service, auditLogRepository } = buildAuditService();
    auditLogRepository.save.mockRejectedValue(new Error('DB down'));

    // 默认 AUDIT_FAIL_FAST=false，不抛错
    await expect(service.logAwait(entry)).resolves.toBeUndefined();
    expect(auditLogRepository.save).toHaveBeenCalledTimes(3); // 重试 3 次

    // 降级文件已写入
    const dir = process.env.AUDIT_DEGRADED_DIR!;
    const files = fs.readdirSync(dir);
    expect(files.length).toBeGreaterThan(0);
    const content = fs.readFileSync(require('path').join(dir, files[0]), 'utf8');
    expect(content).toContain('role_change');
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
