import { ForbiddenException, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { RolesGuard } from './roles.guard';
import { UserRole } from '../entities/user.entity';

const context = (user?: any) => ({
  getHandler: jest.fn(), getClass: jest.fn(),
  switchToHttp: () => ({ getRequest: () => ({ user }) }),
}) as any;

describe('RolesGuard', () => {
  it('requires authentication even without roles metadata', () => {
    const reflector = { getAllAndOverride: jest.fn().mockReturnValue(undefined) } as unknown as Reflector;
    const guard = new RolesGuard(reflector);
    expect(() => guard.canActivate(context())).toThrow(UnauthorizedException);
    expect(guard.canActivate(context({ role: UserRole.USER }))).toBe(true);
  });

  it('rejects missing or insufficient role and permits matching role', () => {
    const reflector = { getAllAndOverride: jest.fn().mockReturnValue([UserRole.ADMIN]) } as unknown as Reflector;
    const guard = new RolesGuard(reflector);
    expect(() => guard.canActivate(context())).toThrow(UnauthorizedException);
    expect(() => guard.canActivate(context({ id: 'u', role: UserRole.USER }))).toThrow(ForbiddenException);
    expect(guard.canActivate(context({ id: 'a', role: UserRole.ADMIN }))).toBe(true);
  });
});
