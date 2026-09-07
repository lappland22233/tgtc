import { GlobalExceptionFilter } from './http-exception.filter';
import { HttpException, HttpStatus } from '@nestjs/common';

describe('GlobalExceptionFilter', () => {
  let filter: GlobalExceptionFilter;
  let res: any;
  let req: any;
  let host: any;

  const makeResponse = (headersSent: boolean) => {
    const r: any = {
      headersSent,
      writableEnded: false,
      destroyed: false,
      end: jest.fn(),
      destroy: jest.fn(),
      status: jest.fn().mockReturnThis(),
      json: jest.fn(),
      setHeader: jest.fn(),
    };
    return r;
  };

  beforeEach(() => {
    filter = new GlobalExceptionFilter();
    req = { method: 'GET', originalUrl: '/api/foo', url: '/api/foo' };
    res = makeResponse(false);
    host = {
      switchToHttp: () => ({ getResponse: () => res, getRequest: () => req }),
    };
  });

  it('G9-08: when headersSent, ends the response instead of leaving connection hanging', () => {
    res.headersSent = true;
    res.writableEnded = false;
    filter.catch(new Error('boom'), host);
    expect(res.end).toHaveBeenCalled();
    expect(res.destroy).not.toHaveBeenCalled();
  });

  it('G9-08: destroys the response when it is not writable (already ended)', () => {
    res.headersSent = true;
    res.writableEnded = true;
    filter.catch(new Error('boom'), host);
    expect(res.end).not.toHaveBeenCalled();
    expect(res.destroy).not.toHaveBeenCalled(); // writableEnded -> early return
  });

  it('G9-09: thrown non-Error value produces 500 + requestId + logs String(exception)', () => {
    const loggerSpy = jest.spyOn((filter as any).logger, 'error').mockImplementation(() => {});
    filter.catch('plain string thrown', host);
    expect(res.status).toHaveBeenCalledWith(HttpStatus.INTERNAL_SERVER_ERROR);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ code: 500, data: null }));
    expect(res.setHeader).toHaveBeenCalledWith('X-Request-Id', expect.any(String));
    const logged = loggerSpy.mock.calls.map((c) => c[0]).join(' ');
    expect(logged).toContain('非 Error 异常');
    expect(logged).toContain('plain string thrown');
    loggerSpy.mockRestore();
  });

  it('returns 4xx message for client HttpException', () => {
    const ex = new HttpException('bad input', HttpStatus.BAD_REQUEST);
    filter.catch(ex, host);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ message: 'bad input', data: null }));
  });

  it('preserves strict upload budget retry metadata in response headers', () => {
    const ex = new HttpException(
      {
        statusCode: HttpStatus.TOO_MANY_REQUESTS,
        code: 'UPLOAD_DISK_BUDGET_BUSY',
        retryAfterMs: 5000,
        message: '服务器正在为另一份大文件保留磁盘空间，请稍候',
      },
      HttpStatus.TOO_MANY_REQUESTS,
    );
    filter.catch(ex, host);

    expect(res.status).toHaveBeenCalledWith(HttpStatus.TOO_MANY_REQUESTS);
    expect(res.setHeader).toHaveBeenCalledWith('X-Tgtc-Error-Code', 'UPLOAD_DISK_BUDGET_BUSY');
    expect(res.setHeader).toHaveBeenCalledWith('Retry-After', '5');
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ code: 429, data: null }));
  });

  it('returns generic 500 + requestId for 5xx HttpException without leaking message', () => {
    const loggerSpy = jest.spyOn((filter as any).logger, 'error').mockImplementation(() => {});
    const ex = new HttpException('internal path /etc/secrets', HttpStatus.INTERNAL_SERVER_ERROR);
    filter.catch(ex, host);
    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ message: '服务器内部错误', data: null }));
    // 内部细节只进服务端日志
    expect(loggerSpy.mock.calls.map((c) => c[0]).join(' ')).toContain('/etc/secrets');
    loggerSpy.mockRestore();
  });
});
