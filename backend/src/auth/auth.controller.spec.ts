import { AuthController } from './auth.controller';

describe('AuthController', () => {
  const authService = {
    register: jest.fn(), login: jest.fn(), revokeToken: jest.fn(),
    sendVerificationCode: jest.fn(), verifyEmail: jest.fn(), resetPassword: jest.fn(),
    getAuthStatus: jest.fn(),
  };
  const jwtService = { decode: jest.fn() };
  const controller = new AuthController(authService as any, jwtService as any);
  const response = () => ({ cookie: jest.fn(), clearCookie: jest.fn() }) as any;
  const request = (overrides: any = {}) => ({
    headers: {}, cookies: {}, ip: '127.0.0.1', secure: false, ...overrides,
  }) as any;

  beforeEach(() => jest.clearAllMocks());

  it('register sets cookie without exposing token', async () => {
    authService.register.mockResolvedValue({ accessToken: 'jwt', user: { id: 'u' } });
    const res = response();
    await expect(controller.register({ email: 'a' } as any, request(), res)).resolves.toEqual({ user: { id: 'u' } });
    expect(res.cookie).toHaveBeenCalledWith('access_token', 'jwt', expect.objectContaining({ httpOnly: true, secure: false, sameSite: 'lax' }));
  });

  it('register supports verification response without token', async () => {
    authService.register.mockResolvedValue({ requiresVerification: true });
    const res = response();
    await expect(controller.register({} as any, request(), res)).resolves.toEqual({ requiresVerification: true });
    expect(res.cookie).not.toHaveBeenCalled();
  });

  it.each([
    [{ secure: true }, true],
    [{ headers: { 'x-forwarded-proto': 'https' } }, true],
  ])('login derives secure cookie from request', async (overrides, secure) => {
    authService.login.mockResolvedValue({ accessToken: 'jwt', user: { id: 'u' } });
    const res = response();
    await expect(controller.login({} as any, request(overrides), res)).resolves.toEqual({ user: { id: 'u' } });
    expect(res.cookie.mock.calls[0][2].secure).toBe(secure);
  });

  it('logout revokes a valid cookie token and clears cookie', async () => {
    jwtService.decode.mockReturnValue({ jti: 'j', sub: 'u', exp: 123 });
    const res = response();
    await expect(controller.logout(request({ cookies: { access_token: 'jwt' } }), res)).resolves.toEqual({ message: '登出成功' });
    expect(authService.revokeToken).toHaveBeenCalledWith('j', 'u', new Date(123000));
    expect(res.clearCookie).toHaveBeenCalled();
  });

  it.each([{}, { cookies: { access_token: 123 } }, { cookies: { access_token: 'x' } }])('logout tolerates absent or invalid token', async (req) => {
    jwtService.decode.mockReturnValue(null);
    await controller.logout(request(req), response());
    expect(authService.revokeToken).not.toHaveBeenCalled();
  });

  it('delegates code, verification, reset, me and status', async () => {
    authService.getAuthStatus.mockResolvedValue({ enabled: true });
    expect(await controller.sendCode({} as any, request())).toEqual({ message: '验证码已发送' });
    expect(await controller.verifyEmail({} as any)).toEqual({ message: '邮箱验证成功' });
    expect(await controller.resetPassword({} as any, request())).toEqual({ message: '密码重置成功' });
    const user = { id: 'u', email: 'e', role: 'user', emailVerified: true, createdAt: new Date() } as any;
    expect(await controller.getMe(user)).toEqual(user);
    expect(await controller.getAuthStatus()).toEqual({ enabled: true });
    expect(authService.sendVerificationCode).toHaveBeenCalled();
    expect(authService.verifyEmail).toHaveBeenCalled();
    expect(authService.resetPassword).toHaveBeenCalled();
  });
});
