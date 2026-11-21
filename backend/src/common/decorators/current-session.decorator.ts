import { createParamDecorator, ExecutionContext, UnauthorizedException } from '@nestjs/common';
import type { Request } from 'express';

export const verifiedSessionId = Symbol('verifiedSessionId');
export type AuthenticatedRequest = Request & { [verifiedSessionId]?: string };

export const CurrentSession = createParamDecorator((_data: unknown, ctx: ExecutionContext): string => {
  const id = ctx.switchToHttp().getRequest<AuthenticatedRequest>()[verifiedSessionId];
  if (!id) throw new UnauthorizedException('请重新登录后发起授权');
  return id;
});
