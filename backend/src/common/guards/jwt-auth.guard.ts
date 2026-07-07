import { Injectable, ExecutionContext, Logger } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { Observable } from 'rxjs';

@Injectable()
export class JwtAuthGuard extends AuthGuard('jwt') {
  private readonly logger = new Logger(JwtAuthGuard.name);

  canActivate(context: ExecutionContext): boolean | Promise<boolean> | Observable<boolean> {
    const request = context.switchToHttp().getRequest();
    try {
      const result = super.canActivate(context);
      // 如果返回 Promise 且失败，则捕获并记录日志
      if (result instanceof Promise) {
        return result.catch((error: unknown) => {
          this.logWarn(error, request);
          return false;
        });
      }
      return result;
    } catch (error: unknown) {
      this.logWarn(error, request);
      return false;
    }
  }

  private logWarn(error: unknown, request: any): void {
    const ip = request.ip || 'unknown';
    const userAgent = (request.headers?.['user-agent'] as string)?.substring(0, 200) || 'unknown';
    const msg = error instanceof Error ? error.message : String(error);
    this.logger.warn(`JWT 认证失败 [${ip} UA:${userAgent}]: ${msg}`);
  }
}
