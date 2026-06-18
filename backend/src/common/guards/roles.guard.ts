import { Injectable, CanActivate, ExecutionContext, ForbiddenException, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { UserRole } from '../entities/user.entity';
import { ROLES_KEY } from '../decorators/roles.decorator';

@Injectable()
export class RolesGuard implements CanActivate {
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
      throw new ForbiddenException(
        `角色 '${user.role}' 无权访问此资源，需要角色: ${requiredRoles.join(', ')}`,
      );
    }
    return true;
  }
}
