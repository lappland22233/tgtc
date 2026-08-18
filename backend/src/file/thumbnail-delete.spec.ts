import { mkdtemp, rm, writeFile, readdir } from 'fs/promises';
import { tmpdir } from 'os';
import * as path from 'path';
import { ThumbnailService } from './thumbnail.service';

describe('ThumbnailService deleteThumbnailsForFileId (G4-08)', () => {
  let cwd: string;
  let service: ThumbnailService;
  const fileId = '77777777-7777-4777-8777-777777777777';

  beforeEach(async () => {
    cwd = await mkdtemp(path.join(tmpdir(), 'thumb-delete-test-'));
    service = Object.create(ThumbnailService.prototype) as ThumbnailService;
    (service as any).thumbnailDir = cwd;
    (service as any).logger = { warn: jest.fn() };
  });

  afterEach(async () => {
    await rm(cwd, { recursive: true, force: true });
  });

  it('删除清单含标准/视频/高清封面三个派生，且磁盘产物全部清除', async () => {
    const derivatives = (service as any).enumerateThumbnailDerivatives(fileId);
    expect(derivatives).toEqual([
      `${fileId}.webp`,
      `${fileId}.video.webp`,
      `${fileId}.video.hd.webp`,
    ]);

    // 写入三个真实产物
    for (const name of derivatives) {
      await writeFile(path.join(cwd, name), Buffer.from('x'));
    }

    await service.deleteThumbnailsForFileId(fileId);

    const remaining = await readdir(cwd);
    expect(remaining).toEqual([]); // 高清封面 hd.webp 不再残留
  });

  it('集中枚举派生物覆盖高清封面，避免遗漏新增派生类型', () => {
    const names = (service as any).enumerateThumbnailDerivatives(fileId) as string[];
    expect(names).toContain(`${fileId}.video.hd.webp`);
  });
});
