import 'reflect-metadata';
import { validate } from 'class-validator';
import { plainToInstance } from 'class-transformer';
import { BanIPDto } from './admin.dto';

describe('BanIPDto', () => {
  it('拒绝没有 expiresAt 的临时封禁', async () => {
    const dto = plainToInstance(BanIPDto, { ip: '127.0.0.1', permanent: false });
    const errors = await validate(dto);
    expect(errors.some((error) => error.property === 'expiresAt')).toBe(true);
  });

  it('拒绝已经过去的临时封禁时间', async () => {
    const dto = plainToInstance(BanIPDto, {
      ip: '127.0.0.1',
      permanent: false,
      expiresAt: new Date(Date.now() - 1000).toISOString(),
    });
    const errors = await validate(dto);
    expect(errors.some((error) => error.property === 'expiresAt')).toBe(true);
  });

  it('接受未来到期时间或无到期时间的永久封禁', async () => {
    const temporary = plainToInstance(BanIPDto, {
      ip: '127.0.0.1',
      permanent: false,
      expiresAt: new Date(Date.now() + 60000).toISOString(),
    });
    const permanent = plainToInstance(BanIPDto, { ip: '127.0.0.1', permanent: true });
    await expect(validate(temporary)).resolves.toHaveLength(0);
    await expect(validate(permanent)).resolves.toHaveLength(0);
  });
});
