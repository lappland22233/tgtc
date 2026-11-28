import 'reflect-metadata';
import { ForbiddenException } from '@nestjs/common';
import { readFileSync } from 'fs';
import { join } from 'path';
import { ApiKeyController } from './api-key.controller';
import { UserRole } from '../common/entities/user.entity';

/**
 * B-13：API 密钥管理控制器此前零直接测试。
 *
 * 关键不变量：
 * - 管理端审计接口有角色门禁（普通用户不得看他人完整 IP）；
 * - 每个端点都把当前登录 user 透传给 service，归属校验不得在 controller 层被绕过；
 * - reveal 只返回 { key }，不泄漏密钥元信息以外的字段；
 * - admin/usage-logs 路由必须先于 :id 声明，否则会被当成 id='admin'。
 */
function makeController() {
  const apiKeyService = {
    create: jest.fn(async (_u: any, name: string) => ({ id: 'k1', name, key: 'tgk_plain' })),
    list: jest.fn(async (_u: any) => [{ id: 'k1' }]),
    revoke: jest.fn(async (_u: any, _id: string) => undefined),
    rotate: jest.fn(async () => ({ id: 'k2', key: 'tgk_new' })),
    reveal: jest.fn(async () => ({ key: 'tgk_plain', id: 'k1', prefix: 'tgk_' })),
    getAllowlist: jest.fn(async () => ({ rules: [] })),
    setAllowlist: jest.fn(async () => ({ rules: [] })),
  };
  const usageService = {
    listForAdmin: jest.fn(async (_page: number, _limit: number, _userId?: string) => ({ items: [], total: 0 })),
    listForKey: jest.fn(async (_u: any, _id: string, _page: number, _limit: number) => ({ items: [], total: 0 })),
  };
  const controller = new ApiKeyController(apiKeyService as any, usageService as any);
  return { controller, apiKeyService, usageService };
}

const owner = { id: 'u1', role: UserRole.USER } as any;
const admin = { id: 'a1', role: UserRole.ADMIN } as any;
const superAdmin = { id: 's1', role: UserRole.SUPER_ADMIN } as any;

describe('ApiKeyController（B-13）', () => {
  it('admin/usage-logs 拒绝普通用户（403），且不查库', async () => {
    const { controller, usageService } = makeController();
    await expect(controller.adminUsageLogs(owner)).rejects.toBeInstanceOf(ForbiddenException);
    expect(usageService.listForAdmin).not.toHaveBeenCalled();
  });

  it.each([admin, superAdmin])('admin/usage-logs 放行 %s 角色', async (user) => {
    const { controller, usageService } = makeController();
    await controller.adminUsageLogs(user, '2', '30', 'u9');
    expect(usageService.listForAdmin).toHaveBeenCalledWith(2, 30, 'u9');
  });

  it('admin/usage-logs 分页非法值回退默认，userId 空串转 undefined', async () => {
    const { controller, usageService } = makeController();
    await controller.adminUsageLogs(admin, 'abc', '', '');
    expect(usageService.listForAdmin).toHaveBeenCalledWith(1, 50, undefined);
  });

  it('每个端点都透传当前 user，归属校验不得被绕过', async () => {
    const { controller, apiKeyService, usageService } = makeController();

    await controller.create(owner, { name: 'n' } as any);
    await controller.list(owner);
    await controller.revoke('k1', owner);
    await controller.rotate('k1', owner, { name: 'n2' } as any);
    await controller.reveal('k1', owner);
    await controller.getAllowlist('k1', owner);
    await controller.setAllowlist('k1', owner, { rules: [] } as any);
    await controller.usageLogs('k1', owner);

    for (const fn of Object.values(apiKeyService) as jest.Mock[]) {
      expect(fn.mock.calls[0][0]).toBe(owner);
    }
    expect(usageService.listForKey.mock.calls[0][0]).toBe(owner);
  });

  it('reveal 只返回 { key }，不泄漏其它字段', async () => {
    const { controller } = makeController();
    const result = await controller.reveal('k1', owner);
    expect(result).toEqual({ key: 'tgk_plain' });
  });

  it('list 包装为 { keys }', async () => {
    const { controller } = makeController();
    expect(await controller.list(owner)).toEqual({ keys: [{ id: 'k1' }] });
  });

  it('revoke 返回统一提示文案', async () => {
    const { controller } = makeController();
    expect(await controller.revoke('k1', owner)).toEqual({ message: 'API 密钥已撤销' });
  });

  it('setAllowlist 缺省 rules 时传空数组（全量替换语义，不得传 undefined）', async () => {
    const { controller, apiKeyService } = makeController();
    await controller.setAllowlist('k1', owner, {} as any);
    expect(apiKeyService.setAllowlist).toHaveBeenCalledWith(owner, 'k1', []);
  });

  it('usageLogs 分页默认 1/20，非法值回退', async () => {
    const { controller, usageService } = makeController();
    await controller.usageLogs('k1', owner);
    expect(usageService.listForKey).toHaveBeenCalledWith(owner, 'k1', 1, 20);
    await controller.usageLogs('k1', owner, 'x', 'y');
    expect(usageService.listForKey).toHaveBeenLastCalledWith(owner, 'k1', 1, 20);
  });

  it('admin/usage-logs 路由声明必须先于 :id，否则会被当成 id=admin', () => {
    const source = readFileSync(join(__dirname, 'api-key.controller.ts'), 'utf8');
    const adminIdx = source.indexOf("@Get('admin/usage-logs')");
    const idIdx = source.indexOf("@Get(':id/");
    expect(adminIdx).toBeGreaterThan(-1);
    expect(idIdx).toBeGreaterThan(-1);
    expect(adminIdx).toBeLessThan(idIdx);
  });

  it('整个控制器只接受 JWT 登录会话（不接受 API Key 自身认证）', () => {
    const source = readFileSync(join(__dirname, 'api-key.controller.ts'), 'utf8');
    expect(source).toContain('@UseGuards(JwtAuthGuard)');
    expect(source).not.toContain('JwtOrApiKeyAuthGuard');
  });
});