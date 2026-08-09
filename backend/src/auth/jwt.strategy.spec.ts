import { JwtStrategy } from './jwt.strategy';
import { UserRole } from '../common/entities/user.entity';

describe('JwtStrategy', () => {
  const auth: any = { isTokenRevoked: jest.fn(), validateUser: jest.fn() };
  const cache: any = { get: jest.fn() };
  const config: any = { get: jest.fn((key: string, fallback?: string) => key === 'JWT_SECRET' ? 'secret-secret-secret-secret-secret-secret' : fallback) };
  const make = () => new JwtStrategy(config, auth, cache);
  const payload: any = { sub: 'u', email: 'u@example.com', role: UserRole.USER, jti: 'j', iat: 100 };
  const user: any = { id: 'u', email: payload.email, role: payload.role, emailVerified: true, isBanned: false };

  beforeEach(() => {
    jest.clearAllMocks();
    auth.isTokenRevoked.mockResolvedValue(false);
    auth.validateUser.mockResolvedValue(user);
    cache.get.mockResolvedValue('false');
  });

  it('requires JWT secret', () => {
    const missing: any = { get: jest.fn((key: string, fallback?: string) => key === 'JWT_SECRET' ? undefined : fallback) };
    expect(() => new JwtStrategy(missing, auth, cache)).toThrow('JWT_SECRET');
  });

  it.each([
    [null, '无效'], [{ ...payload, sub: '' }, '用户标识'], [{ ...payload, email: 1 }, '邮箱'],
    [{ ...payload, role: '' }, '角色'], [{ ...payload, jti: undefined }, '唯一标识'],
    [{ ...payload, role: 'root' }, '无效的角色'],
  ])('rejects malformed payload %#', async (bad, message) => {
    await expect(make().validate(bad as any)).rejects.toThrow(message);
  });

  it('rejects revoked, missing, stale, banned and changed users', async () => {
    auth.isTokenRevoked.mockResolvedValueOnce(true);
    await expect(make().validate(payload)).rejects.toThrow('已吊销');
    auth.validateUser.mockResolvedValueOnce(null);
    await expect(make().validate(payload)).rejects.toThrow('不存在');
    auth.validateUser.mockResolvedValueOnce({ ...user, passwordUpdatedAt: new Date(101000) });
    await expect(make().validate(payload)).rejects.toThrow('密码已变更');
    auth.validateUser.mockResolvedValueOnce({ ...user, isBanned: true });
    await expect(make().validate(payload)).rejects.toThrow('封禁');
    auth.validateUser.mockResolvedValueOnce({ ...user, email: 'other@example.com' });
    await expect(make().validate(payload)).rejects.toThrow('Token 已失效');
  });

  it('enforces optional email verification and returns valid user', async () => {
    cache.get.mockResolvedValue('true');
    auth.validateUser.mockResolvedValueOnce({ ...user, emailVerified: false });
    await expect(make().validate(payload)).rejects.toThrow('验证邮箱');
    cache.get.mockResolvedValue('false');
    await expect(make().validate(payload)).resolves.toBe(user);
  });
});
