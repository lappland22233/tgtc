import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { AdminFilesQueryDto } from './admin.dto';

describe('AdminFilesQueryDto (G7-07)', () => {
  it('接受合法 page/limit 并做类型转换', async () => {
    const dto = plainToInstance(AdminFilesQueryDto, {
      page: '2',
      limit: '50',
      sortBy: 'size',
      sortOrder: 'desc',
    });
    expect(dto.page).toBe(2);
    expect(dto.limit).toBe(50);
    const errors = await validate(dto, { whitelist: true, forbidNonWhitelisted: true });
    expect(errors).toHaveLength(0);
  });

  it('拒绝 limit 超过 100', async () => {
    const dto = plainToInstance(AdminFilesQueryDto, { limit: 1000 });
    const errors = await validate(dto, { whitelist: true, forbidNonWhitelisted: true });
    expect(errors.map(e => e.property)).toContain('limit');
  });

  it('拒绝非整数 page', async () => {
    const dto = plainToInstance(AdminFilesQueryDto, { page: 1.5 });
    const errors = await validate(dto, { whitelist: true, forbidNonWhitelisted: true });
    expect(errors.map(e => e.property)).toContain('page');
  });

  it('拒绝白名单之外的排序字段（防注入）', async () => {
    const dto = plainToInstance(AdminFilesQueryDto, { sortBy: 'DROP TABLE files' });
    const errors = await validate(dto, { whitelist: true, forbidNonWhitelisted: true });
    expect(errors.map(e => e.property)).toContain('sortBy');
  });

  it('拒绝非法排序方向', async () => {
    const dto = plainToInstance(AdminFilesQueryDto, { sortOrder: 'sideways' });
    const errors = await validate(dto, { whitelist: true, forbidNonWhitelisted: true });
    expect(errors.map(e => e.property)).toContain('sortOrder');
  });
});
