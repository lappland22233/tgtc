import { Injectable, CanActivate, ExecutionContext, ForbiddenException, UnauthorizedException, Logger } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { UserRole } from '../entities/user.entity';
import { ROLES_KEY } from '../decorators/roles.decorator';

@Injectable()
export class RolesGuard implements CanActivate {
  private readonly logger = new Logger(RolesGuard.name);

  constructor(private reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const requiredRoles = this.reflector.getAllAndOverride<UserRole[]>(
      ROLES_KEY,
      [context.getHandler(), context.getClass()],
    );
    const { user } = context.switchToHttp().getRequest();

    if (!requiredRoles) {
      // 无 @Roles 装饰器时，至少要求用户已认证（白名单策略）
      // 防止开发者遗漏装饰器导致端点无角色保护
      if (!user) {
        throw new UnauthorizedException('用户未认证');
      }
      return true;
    }

    if (!user) {
      throw new UnauthorizedException('用户未认证');
    }
    if (!requiredRoles.includes(user.role)) {
      // 详细角色信息仅记录到服务端日志，避免向客户端泄漏所需角色名
      this.logger.warn(
        `角色越权访问被拒绝 [userId:${user.id} role:${user.role} required:${requiredRoles.join(', ')}]`,
      );
      throw new ForbiddenException('无权访问此资源');
    }
    return true;
  }
}
