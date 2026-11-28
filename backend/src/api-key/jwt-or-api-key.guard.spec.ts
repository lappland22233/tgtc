import 'reflect-metadata';
import { UnauthorizedException } from '@nestjs/common';
import { JwtOrApiKeyAuthGuard } from './jwt-or-api-key.guard';

/**
 * B-13：组合认证 Guard 的放行矩阵此前零直接测试。
 *
 * 最关键的安全不变量：**携带 X-API-Key 时认证失败必须 fail-closed，绝不回退 JWT**，
 * 否则「无效密钥静默降级为他人 JWT」会造成凭据混淆与越权。
 */
function makeContext(headers: Record<string, unknown> = {}, ip = '203.0.113.9') {
  const request: any = { headers, ip, ips: [], socket: { remoteAddress: ip } };
  return {
    request,
    context: { switchToHttp: () => ({ getRequest: () => request }) } as any,
  };
}

function makeGuard(authenticate: jest.Mock) {
  const apiKeyService = { authenticate } as any;
  const guard = new JwtOrApiKeyAuthGuard(apiKeyService);
  // 必须 spy 父类 AuthGuard('jwt') 的原型：spy 自身原型会拦掉 guard.canActivate 本身，
  // 既测不到 super.canActivate 是否被调用，也会让 mockReturnValue 直接短路整个守卫。
  const authGuardProto = Object.getPrototypeOf(Object.getPrototypeOf(guard));
  const jwtSpy = jest.spyOn(authGuardProto, 'canActivate');
  return { guard, jwtSpy };
}

describe('JwtOrApiKeyAuthGuard 放行矩阵（B-13）', () => {
  afterEach(() => jest.restoreAllMocks());

  it('携带有效 X-API-Key → 放行并把用户挂到 request', async () => {
    const user = { id: 'u1', email: 'a@b.c' };
    const authenticate = jest.fn().mockResolvedValue(user);
    const { guard, jwtSpy } = makeGuard(authenticate);
    const { context, request } = makeContext({ 'x-api-key': 'tgk_valid' });

    expect(await guard.canActivate(context)).toBe(true);
    expect(request.user).toBe(user);
    expect(authenticate).toHaveBeenCalledWith('tgk_valid', '203.0.113.9');
    expect(jwtSpy).not.toHaveBeenCalled();
  });

  it('X-API-Key 认证失败 → 401，且绝不回退 JWT（fail-closed）', async () => {
    const authenticate = jest.fn().mockRejectedValue(new Error('密钥已撤销'));
    const { guard, jwtSpy } = makeGuard(authenticate);
    const { context } = makeContext({ 'x-api-key': 'tgk_revoked' });

    await expect(Promise.resolve().then(() => guard.canActivate(context))).rejects.toBeInstanceOf(UnauthorizedException);
    expect(jwtSpy).not.toHaveBeenCalled();
  });

  it('API Key 路径抛非 401 异常时统一归一为 401，不泄漏内部错误类型', async () => {
    const authenticate = jest.fn().mockRejectedValue(new TypeError('内部错误细节'));
    const { guard } = makeGuard(authenticate);
    const { context } = makeContext({ 'x-api-key': 'tgk_x' });

    await expect(Promise.resolve().then(() => guard.canActivate(context))).rejects.toThrow('认证失败');
  });

  it('已是 UnauthorizedException 时原样保留（保留 passport 的语义）', async () => {
    const original = new UnauthorizedException('令牌已过期');
    const authenticate = jest.fn().mockRejectedValue(original);
    const { guard } = makeGuard(authenticate);
    const { context } = makeContext({ 'x-api-key': 'tgk_x' });

    await expect(Promise.resolve().then(() => guard.canActivate(context))).rejects.toBe(original);
  });

  it.each([
    ['空白字符串', '   '],
    ['空字符串', ''],
    ['非字符串（数组）', ['tgk_a', 'tgk_b']],
    ['undefined', undefined],
  ])('X-API-Key 为%s 时视为未携带，走 JWT 链路', async (_label, header) => {
    const authenticate = jest.fn();
    const { guard, jwtSpy } = makeGuard(authenticate);
    jwtSpy.mockReturnValue(true);
    const { context } = makeContext({ 'x-api-key': header });

    expect(await guard.canActivate(context)).toBe(true);
    expect(authenticate).not.toHaveBeenCalled();
    expect(jwtSpy).toHaveBeenCalled();
  });

  it('未携带 X-API-Key → 走 JWT 链路', async () => {
    const authenticate = jest.fn();
    const { guard, jwtSpy } = makeGuard(authenticate);
    jwtSpy.mockReturnValue(true);
    const { context } = makeContext({});

    expect(await guard.canActivate(context)).toBe(true);
    expect(jwtSpy).toHaveBeenCalledWith(context);
  });

  it('JWT 链路 Promise 拒绝 → 归一为 401', async () => {
    const { guard, jwtSpy } = makeGuard(jest.fn());
    jwtSpy.mockReturnValue(Promise.reject(new Error('jwt malformed')));
    const { context } = makeContext({});

    await expect(Promise.resolve().then(() => guard.canActivate(context))).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('JWT 链路同步抛错 → 归一为 401', async () => {
    const { guard, jwtSpy } = makeGuard(jest.fn());
    jwtSpy.mockImplementation(() => { throw new Error('strategy missing'); });
    const { context } = makeContext({});

    await expect(Promise.resolve().then(() => guard.canActivate(context))).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('传给 authenticate 的 IP 走 trust proxy 语义，不取可伪造的 XFF 首项', async () => {
    const authenticate = jest.fn().mockResolvedValue({ id: 'u1' });
    const { guard } = makeGuard(authenticate);
    const { context, request } = makeContext({ 'x-api-key': 'tgk_valid' });
    request.headers['x-forwarded-for'] = '1.2.3.4';
    request.ip = '203.0.113.9';

    await guard.canActivate(context);

    expect(authenticate).toHaveBeenCalledWith('tgk_valid', '203.0.113.9');
  });

  it('密钥首尾空白被裁剪后再认证', async () => {
    const authenticate = jest.fn().mockResolvedValue({ id: 'u1' });
    const { guard } = makeGuard(authenticate);
    const { context } = makeContext({ 'x-api-key': '  tgk_valid  ' });

    await guard.canActivate(context);

    expect(authenticate).toHaveBeenCalledWith('tgk_valid', expect.any(String));
  });
});