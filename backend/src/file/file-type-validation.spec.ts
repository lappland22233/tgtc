jest.mock('file-type', () => ({
  fileTypeFromBuffer: jest.fn(() => {
    throw new Error('ZIP 快速路径不应调用 file-type');
  }),
}), { virtual: true });

import { FileUploadConfigService } from './file-upload-config.service';

/**
 * M6 拆分：类型校验实现已从 FileService 下沉到 FileUploadConfigService，
 * 断言与用例保持不变，仅把被测对象改为承载实现的类（行为契约不变）。
 */
function createService(): FileUploadConfigService {
  return Object.create(FileUploadConfigService.prototype) as FileUploadConfigService;
}

describe('FileUploadConfigService file type validation', () => {
  it('accepts a ZIP prefix sample even when the first entry exceeds the sample', async () => {
    const service = createService();
    Object.assign(service, {
      fileTypeMode: 'whitelist',
      fileTypeFilter: ['.zip'],
    });
    const sample = Buffer.alloc(4100);
    sample.set([0x50, 0x4b, 0x03, 0x04], 0);
    sample.writeUInt32LE(10 * 1024 * 1024, 18);

    await expect(service.isFileTypeAllowed('archive.zip', sample)).resolves.toEqual({ allowed: true });
  });

  it('rejects a ZIP by the configured blacklist without parsing its entries', async () => {
    const service = createService();
    Object.assign(service, {
      fileTypeMode: 'blacklist',
      fileTypeFilter: ['.zip'],
    });
    const sample = Buffer.alloc(4100);
    sample.set([0x50, 0x4b, 0x03, 0x04], 0);
    sample.writeUInt32LE(10 * 1024 * 1024, 18);

    await expect(service.isFileTypeAllowed('archive.zip', sample)).resolves.toEqual({
      allowed: false,
      reason: '文件类型 .zip 被拒绝：该类型在禁止列表中',
    });
  });
});
