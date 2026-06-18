import { Injectable, ExecutionContext, Logger } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';

@Injectable()
export class JwtAuthGuard extends AuthGuard('jwt') {
  private readonly logger = new Logger(JwtAuthGuard.name);

  canActivate(context: ExecutionContext) {
    const request = context.switchToHttp().getRequest();
    // 委托 Passport 进行 JWT 验证，并在失败时记录日志
    const result = super.canActivate(context);
    Promise.resolve(result).catch((error: unknown) => {
      const ip = request.ip || 'unknown';
      const userAgent = (request.headers?.['user-agent'] as string)?.substring(0, 200) || 'unknown';
      const msg = error instanceof Error ? error.message : String(error);
      this.logger.warn(`JWT 认证失败 [${ip} UA:${userAgent}]: ${msg}`);
    });
    return result;
  }
}
