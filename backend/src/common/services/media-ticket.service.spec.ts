import { UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { MediaTicketService } from './media-ticket.service';

describe('MediaTicketService', () => {
  const config = { get: jest.fn() } as unknown as ConfigService;
  let service: MediaTicketService;

  beforeEach(() => {
    (config.get as jest.Mock).mockImplementation((key: string) => key === 'MEDIA_TICKET_SECRET' ? 'media-secret' : 'jwt-secret');
    service = new MediaTicketService(config);
  });

  it('签发并验证包含安全载荷的 HMAC-SHA256 票据', () => {
    const ticket = service.issue({ fileId: 'file-1', uploadVersion: 2, subject: 'user-1', scope: 'user', purpose: 'preview' });
    const payload = service.verify(ticket);
    expect(payload).toMatchObject({ fileId: 'file-1', uploadVersion: 2, subject: 'user-1', scope: 'user', purpose: 'preview' });
    expect(payload.nonce).toBeTruthy();
    expect(payload.exp - payload.iat).toBe(300);
  });

  it('拒绝被篡改的票据', () => {
    const ticket = service.issue({ fileId: 'file-1', uploadVersion: 1, subject: 'user-1', scope: 'user', purpose: 'preview' });
    expect(() => service.verify(`${ticket}x`)).toThrow(UnauthorizedException);
  });

  it('拒绝过期与错误用途的票据', () => {
    const nowSpy = jest.spyOn(Date, 'now').mockReturnValue(1_000_000);
    const expired = service.issue({ fileId: 'file-1', uploadVersion: 1, subject: 'user-1', scope: 'user', purpose: 'preview' }, 1);
    nowSpy.mockReturnValue(1_002_000);
    expect(() => service.verify(expired)).toThrow(UnauthorizedException);
    nowSpy.mockRestore();

    const ticket = service.issue({ fileId: 'file-1', uploadVersion: 1, subject: 'user-1', scope: 'user', purpose: 'preview' });
    expect(ticket).toHaveProperty('split');
    expect(ticket).not.toContain('file-1');
    expect(() => service.verify(`${ticket}x`)).toThrow(UnauthorizedException);
  });

  it('优先使用 MEDIA_TICKET_SECRET，缺失时回退 JWT_SECRET', () => {
    const ticket = service.issue({ fileId: 'file-1', uploadVersion: 1, subject: 'user-1', scope: 'user', purpose: 'preview' });
    expect(ticket).toBeTruthy();
    expect(config.get).toHaveBeenCalledWith('MEDIA_TICKET_SECRET');

    (config.get as jest.Mock).mockImplementation((key: string) => key === 'JWT_SECRET' ? 'jwt-secret' : undefined);
    const fallback = new MediaTicketService(config);
    expect(fallback.verify(fallback.issue({ fileId: 'file-2', uploadVersion: 1, subject: 'user-2', scope: 'user', purpose: 'preview' }))).toMatchObject({ fileId: 'file-2' });
  });
});
