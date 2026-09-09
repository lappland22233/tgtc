// file-type 已在 jest.config moduleNameMapper 中映射为 CJS 桩（ESM-only 包）。
import { RequestMethod, ForbiddenException } from '@nestjs/common';
import { Request } from 'express';
import { FileController, assertSameOriginWrite } from './file.controller';

/**
 * P1-10 回归：download-link 为写语义端点（permanent 会将私有文件转公开），
 * 必须只接受 POST——认证 Cookie 为 SameSite=Lax，跨站顶层导航 GET 会携带
 * Cookie 且无 CSRF 防护，曾被诱导访问 GET 路由静默转公开。
 */
describe('FileController download-link 路由（P1-10 CSRF 回归）', () => {
  it('download-link 只映射 POST，旧 GET 路由不再存在', () => {
    const pathMetadata = Reflect.getMetadata('path', FileController.prototype.getDownloadLink) as string;
    const methodMetadata = Reflect.getMetadata('method', FileController.prototype.getDownloadLink) as RequestMethod;
    expect(pathMetadata).toBe(':id/download-link');
    expect(methodMetadata).toBe(RequestMethod.POST);
  });

  describe('assertSameOriginWrite（同源校验纵深防御）', () => {
    function makeRequest(headers: Record<string, string>, hostname: string): Request {
      return { headers, hostname } as unknown as Request;
    }

    it('非浏览器客户端（无 Origin/Referer）放行', () => {
      expect(() => assertSameOriginWrite(makeRequest({}, 'files.example.com'))).not.toThrow();
    });

    it('跨站 Origin 被拒绝（403）', () => {
      expect(() =>
        assertSameOriginWrite(makeRequest({ origin: 'https://evil.example' }, 'files.example.com')),
      ).toThrow(ForbiddenException);
    });

    it('跨站 Referer 兜底校验被拒绝（403）', () => {
      expect(() =>
        assertSameOriginWrite(makeRequest({ referer: 'https://evil.example/attack' }, 'files.example.com')),
      ).toThrow(ForbiddenException);
    });

    it('同源 Origin 放行（忽略 scheme，兼容反代 TLS 终止）', () => {
      expect(() =>
        assertSameOriginWrite(makeRequest({ origin: 'https://files.example.com' }, 'files.example.com')),
      ).not.toThrow();
    });

    it('非法 Origin 头被拒绝（403）', () => {
      expect(() =>
        assertSameOriginWrite(makeRequest({ origin: 'not-a-url' }, 'files.example.com')),
      ).toThrow(ForbiddenException);
    });
  });
});
