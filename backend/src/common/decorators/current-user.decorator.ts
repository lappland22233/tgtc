import { createParamDecorator, ExecutionContext, UnauthorizedException } from '@nestjs/common';

/**
 * 提取当前认证用户的参数装饰器。
 * 当 Guard 未正确设置 `request.user` 时返回 undefined，
 * 调用方应检查 null 或使用 `@UseGuards(JwtAuthGuard)` 确保认证。
 */
export const CurrentUser = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext) => {
    const request = ctx.switchToHttp().getRequest();
    if (!request.user) {
      throw new UnauthorizedException('用户未认证');
    }
    return request.user;
  },
);
