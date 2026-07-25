import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { UploadConfigDto } from './admin.dto';

describe('UploadConfigDto', () => {
  it('accepts the unlimited access count values sent by the config page', async () => {
    const dto = plainToInstance(UploadConfigDto, {
      maxFileSize: 80 * 1024 * 1024,
      fileTypeMode: 'blacklist',
      fileTypeFilter: '.exe,.dll',
      accessCountDefault: -1,
      accessCountMax: -1,
    });

    await expect(validate(dto, { whitelist: true, forbidNonWhitelisted: true })).resolves.toHaveLength(0);
  });

  it('rejects access counts below -1', async () => {
    const dto = plainToInstance(UploadConfigDto, {
      accessCountDefault: -2,
      accessCountMax: -2,
    });

    const errors = await validate(dto, { whitelist: true, forbidNonWhitelisted: true });
    expect(errors.map(error => error.property)).toEqual(expect.arrayContaining([
      'accessCountDefault',
      'accessCountMax',
    ]));
  });
});
