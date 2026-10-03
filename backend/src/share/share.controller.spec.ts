import { ShareController } from './share.controller';

/**
 * SEC-103 回归：分享密码校验的响应体不得再携带访问凭证。
 * 验证通过后的 access JWT 仅写入 HttpOnly `share_access` Cookie（C-02 路径不变），
 * 响应体不含任何令牌字段。
 */
describe('ShareController.verifyPassword（SEC-103）', () => {
  function makeController() {
    const shareService = {
      verifyPassword: jest.fn(),
    };
    const controller = new ShareController(
      shareService as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
    );
    return { controller, shareService };
  }

  function makeRequest() {
    return { cookies: {}, headers: {}, ip: '203.0.113.7' } as any;
  }

  function makeResponse() {
    return { cookie: jest.fn() } as any;
  }

  it('验证成功后凭据仅写入 HttpOnly Cookie，响应体不再返回 accessJwt', async () => {
    const { controller, shareService } = makeController();
    shareService.verifyPassword.mockResolvedValue({ accessJwt: 'signed-access-jwt' });
    const res = makeResponse();

    const result = await controller.verifyPassword(
      'tok123456789',
      { password: 'correct-horse' } as any,
      makeRequest(),
      res,
    );

    // Cookie 下发路径保持不变（HttpOnly）
    expect(res.cookie).toHaveBeenCalledWith(
      'share_access',
      'signed-access-jwt',
      expect.objectContaining({ httpOnly: true }),
    );
    // 响应体不含访问凭证
    expect(result).not.toHaveProperty('accessJwt');
    expect(JSON.stringify(result)).not.toContain('signed-access-jwt');
    expect(result).toEqual({ verified: true });
  });
});
