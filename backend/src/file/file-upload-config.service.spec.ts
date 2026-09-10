import 'reflect-metadata';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/** 可控的 magic bytes 检测结果（file-type 为 ESM-only，测试中替换为桩） */
const fileTypeFromBufferMock = jest.fn();
jest.mock('file-type', () => ({
  fileTypeFromBuffer: (...args: unknown[]) => fileTypeFromBufferMock(...args),
}), { virtual: true });

import { FileUploadConfigService } from './file-upload-config.service';

/**
 * M6 拆分回归：上传配置（大小上限 / 类型过滤模式与清单）与校验语义
 * 从 FileService 下沉后必须保持一致，尤其：
 * - 配置解析（逗号分隔、去空格、小写归一）
 * - 白名单/黑名单两种模式下的放行与拒绝文案
 * - 样本读取的内存态与磁盘态
 */

function createService(overrides: { maxFileSize?: string; mode?: string; filter?: string } = {}) {
  const configService = { get: jest.fn(() => overrides.maxFileSize ?? '1048576') };
  const configCacheService = {
    get: jest.fn(async (key: string, fallback: string) => {
      if (key === 'MAX_FILE_SIZE') return overrides.maxFileSize ?? '1048576';
      if (key === 'FILE_TYPE_MODE') return overrides.mode ?? 'blacklist';
      if (key === 'FILE_TYPE_FILTER') return overrides.filter ?? '';
      return fallback;
    }),
  };
  const service = new FileUploadConfigService(configService as never, configCacheService as never);
  return { service, configCacheService };
}

describe('FileUploadConfigService（M6 拆分契约）', () => {
  it('构造时以 ConfigService 的值作为兜底，reload 后以配置缓存为准', async () => {
    const { service, configCacheService } = createService({ maxFileSize: '20971520' });

    expect(service.maxFileSizeBytes).toBe(20 * 1024 * 1024);

    configCacheService.get.mockImplementation(async (key: string, fallback: string) => {
      if (key === 'MAX_FILE_SIZE') return '5242880';
      if (key === 'FILE_TYPE_MODE') return 'whitelist';
      if (key === 'FILE_TYPE_FILTER') return ' .png , .JPG ,, ';
      return fallback;
    });

    await service.reload();

    expect(service.maxFileSizeBytes).toBe(5 * 1024 * 1024);
    await expect(service.getMaxFileSize()).resolves.toBe(5 * 1024 * 1024);
    // 类型清单：去空格、统一小写、剔除空项
    await expect(service.getFileTypeConfig()).resolves.toEqual({
      fileTypeMode: 'whitelist',
      fileTypeFilter: ['.png', '.jpg'],
    });
  });

  it('非法的类型模式回退为 blacklist', async () => {
    const { service } = createService({ mode: 'whatever' });

    await service.reload();

    await expect(service.getFileTypeConfig()).resolves.toEqual({
      fileTypeMode: 'blacklist',
      fileTypeFilter: [],
    });
  });

  it('getFileTypeConfig 返回副本，外部修改不影响内部状态', async () => {
    const { service } = createService({ filter: '.exe' });
    await service.reload();

    const config = await service.getFileTypeConfig();
    config.fileTypeFilter.push('.hacked');

    await expect(service.getFileTypeConfig()).resolves.toEqual({
      fileTypeMode: 'blacklist',
      fileTypeFilter: ['.exe'],
    });
  });

  it('黑名单为空时全部放行；白名单为空时全部拒绝', async () => {
    const blacklist = createService({ mode: 'blacklist', filter: '' });
    await blacklist.service.reload();
    await expect(blacklist.service.isFileTypeAllowed('anything.unknown')).resolves.toEqual({ allowed: true });

    const whitelist = createService({ mode: 'whitelist', filter: '' });
    await whitelist.service.reload();
    await expect(whitelist.service.isFileTypeAllowed('.png')).resolves.toEqual(
      expect.objectContaining({ allowed: false, reason: expect.stringContaining('白名单') }),
    );
  });

  it('黑名单命中后缀时拒绝并给出禁止列表文案', async () => {
    const { service } = createService({ mode: 'blacklist', filter: '.exe,.bat' });
    await service.reload();

    await expect(service.isFileTypeAllowed('payload.exe')).resolves.toEqual({
      allowed: false,
      reason: '文件类型 .exe 被拒绝：该类型在禁止列表中',
    });
    await expect(service.isFileTypeAllowed('readme.txt')).resolves.toEqual({ allowed: true });
  });

  it('白名单模式：无法识别类型直接拒绝（不给后缀回退机会）', async () => {
    const { service } = createService({ mode: 'whitelist', filter: '.png' });
    await service.reload();

    await expect(service.isFileTypeAllowed('notes.txt')).resolves.toEqual({
      allowed: false,
      reason: '无法识别文件类型，白名单模式下仅允许可明确识别的文件类型',
    });
  });

  it('白名单模式：识别出的类型命中放行、未命中给出允许列表文案', async () => {
    const { service } = createService({ mode: 'whitelist', filter: '.png' });
    await service.reload();
    const buffer = Buffer.from([0x89, 0x50, 0x4e, 0x47]);

    fileTypeFromBufferMock.mockResolvedValueOnce({ ext: 'png' });
    await expect(service.isFileTypeAllowed('photo.png', buffer)).resolves.toEqual({ allowed: true });

    fileTypeFromBufferMock.mockResolvedValueOnce({ ext: 'txt' });
    await expect(service.isFileTypeAllowed('notes.txt', buffer)).resolves.toEqual({
      allowed: false,
      reason: '文件类型 .txt 被拒绝：该类型不在允许列表中',
    });
  });

  it('复合扩展名优先匹配（.tar.gz 不被当作 .gz）', async () => {
    const { service } = createService({ mode: 'blacklist', filter: '.tar.gz' });
    await service.reload();

    await expect(service.isFileTypeAllowed('backup.tar.gz')).resolves.toEqual(
      expect.objectContaining({ allowed: false, reason: expect.stringContaining('.tar.gz') }),
    );
  });

  it('getFileSample 优先取内存 buffer，并对样本长度做上限截断', () => {
    const { service } = createService();

    const buffer = Buffer.alloc(10_000, 1);
    const sample = service.getFileSample({ buffer } as Express.Multer.File, 100);
    expect(sample).toHaveLength(100);

    // 既无 buffer 也无有效 path：返回空样本（由调用方按未识别类型处理）
    expect(service.getFileSample({} as Express.Multer.File)).toHaveLength(0);
  });

  it('getFileSampleFromPath 读取磁盘前若干字节', () => {
    const { service } = createService();
    const filePath = path.join(os.tmpdir(), `tgtc-upload-config-${process.pid}.bin`);
    fs.writeFileSync(filePath, Buffer.from('0123456789'));

    try {
      expect(service.getFileSampleFromPath(filePath, 4).toString()).toBe('0123');
    } finally {
      fs.unlinkSync(filePath);
    }
  });
});
