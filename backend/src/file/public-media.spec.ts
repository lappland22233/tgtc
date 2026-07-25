import 'reflect-metadata';
import { BadRequestException, ForbiddenException } from '@nestjs/common';

jest.mock('file-type', () => ({ fileTypeFromBuffer: jest.fn() }), { virtual: true });

import { FileService } from './file.service';
import { FileAccessType } from '../common/entities/file.entity';

function createService(file: Record<string, unknown>) {
  const service = Object.create(FileService.prototype) as FileService;
  Object.assign(service, {
    fileRepository: { findOne: jest.fn().mockResolvedValue(file) },
    fileCacheService: { getCachedPath: jest.fn().mockReturnValue(null) },
  });
  return service;
}

const publicImage = {
  id: 'a58f374f-1b14-40f6-a3a8-617d1e5b0e90',
  originalName: 'photo.png',
  mimeType: 'image/png',
  size: 128,
  uploaderId: '1ad590a3-88c4-4742-a1cb-8a0375480e87',
  accessType: FileAccessType.PUBLIC,
  isDeleted: false,
  password: null,
  maxAccessCount: -1,
  expiresIn: null,
  expiresStartAt: null,
  status: 'ready',
};

describe('FileService public media validation', () => {
  it('accepts an unrestricted public image', async () => {
    const service = createService(publicImage);
    await expect((service as any).getPublicMediaFile(publicImage.id)).resolves.toEqual(publicImage);
  });

  it('rejects non-media files', async () => {
    const service = createService({ ...publicImage, mimeType: 'application/pdf' });
    await expect((service as any).getPublicMediaFile(publicImage.id)).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects private or constrained media files', async () => {
    const privateService = createService({ ...publicImage, accessType: FileAccessType.PRIVATE });
    await expect((privateService as any).getPublicMediaFile(publicImage.id)).rejects.toBeInstanceOf(ForbiddenException);

    const protectedService = createService({ ...publicImage, maxAccessCount: 10 });
    await expect((protectedService as any).getPublicMediaFile(publicImage.id)).rejects.toBeInstanceOf(ForbiddenException);

    const expiringService = createService({ ...publicImage, expiresIn: 24, expiresStartAt: null });
    await expect((expiringService as any).getPublicMediaFile(publicImage.id)).rejects.toBeInstanceOf(ForbiddenException);
  });
});
