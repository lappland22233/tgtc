jest.mock('file-type', () => ({
  fileTypeFromBuffer: jest.fn(() => {
    throw new Error('ZIP 快速路径不应调用 file-type');
  }),
}), { virtual: true });

import { FileService } from './file.service';

function createService(): FileService {
  return Object.create(FileService.prototype) as FileService;
}

describe('FileService file type validation', () => {
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
