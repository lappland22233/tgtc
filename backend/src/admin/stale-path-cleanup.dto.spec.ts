import 'reflect-metadata';
import { validate } from 'class-validator';
import { plainToInstance } from 'class-transformer';
import { StalePathCleanupDto } from './admin.dto';

describe('StalePathCleanupDto', () => {
  it('拒绝非法 mode', async () => {
    const dto = plainToInstance(StalePathCleanupDto, { mode: 'delete-all' });
    const errors = await validate(dto);
    expect(errors.some((error) => error.property === 'mode')).toBe(true);
  });

  it('接受 dry-run 与 apply', async () => {
    const dryRun = plainToInstance(StalePathCleanupDto, { mode: 'dry-run' });
    const apply = plainToInstance(StalePathCleanupDto, { mode: 'apply' });
    await expect(validate(dryRun)).resolves.toHaveLength(0);
    await expect(validate(apply)).resolves.toHaveLength(0);
  });

  it('缺省 mode 默认 dry-run', async () => {
    const dto = plainToInstance(StalePathCleanupDto, {});
    expect(dto.mode).toBe('dry-run');
  });
});
