import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { CreateShareDto, UpdateShareDto } from './share.dto';

/**
 * G5-09：分享密码最小长度 + 字符类别要求（Create/Update 同步）。
 * 弱密码（纯数字/纯字母/过短）应被 DTO 层拒绝，与 G5-08 的 token 累计锁定配合提高爆破成本。
 */
describe('Share DTO - 密码强度（G5-09）', () => {
  function makeCreate(password?: string) {
    return plainToInstance(CreateShareDto, {
      targetType: 'file',
      targetId: '11111111-1111-4111-8111-111111111111',
      password,
    });
  }
  function makeUpdate(password?: string) {
    return plainToInstance(UpdateShareDto, { password });
  }

  it('Create：空/不传密码合法（公开分享）', async () => {
    for (const dto of [makeCreate(undefined), makeCreate('')]) {
      const errors = await validate(dto, { whitelist: true, forbidNonWhitelisted: true });
      expect(errors.filter((e) => e.property === 'password')).toHaveLength(0);
    }
  });

  it('Create：长度不足 6 的密码被拒', async () => {
    const dto = makeCreate('ab1!'); // 4 字符
    const errors = await validate(dto, { whitelist: true, forbidNonWhitelisted: true });
    expect(errors.map((e) => e.property)).toContain('password');
  });

  it('Create：单类字符（纯数字）被拒', async () => {
    const dto = makeCreate('123456'); // 6 位纯数字
    const errors = await validate(dto, { whitelist: true, forbidNonWhitelisted: true });
    expect(errors.map((e) => e.property)).toContain('password');
  });

  it('Create：单类字符（纯字母）被拒', async () => {
    const dto = makeCreate('abcdef'); // 6 位纯字母
    const errors = await validate(dto, { whitelist: true, forbidNonWhitelisted: true });
    expect(errors.map((e) => e.property)).toContain('password');
  });

  it('Create：至少两类字符的密码通过', async () => {
    for (const pwd of ['abc123', 'abCDef', 'ab!cde', 'ABC123', 'abc!@#', 'Ab1cde', 'P@ssw0rd']) {
      const dto = makeCreate(pwd);
      const errors = await validate(dto, { whitelist: true, forbidNonWhitelisted: true });
      expect(errors.filter((e) => e.property === 'password')).toHaveLength(0);
    }
  });

  it('Update：与 Create 同步的强度校验', async () => {
    // 弱密码被拒
    const weak = await validate(makeUpdate('123456'), { whitelist: true, forbidNonWhitelisted: true });
    expect(weak.map((e) => e.property)).toContain('password');
    // 强密码通过
    const strong = await validate(makeUpdate('Abc123!'), { whitelist: true, forbidNonWhitelisted: true });
    expect(strong.filter((e) => e.property === 'password')).toHaveLength(0);
  });
});
