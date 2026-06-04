import { Injectable, UnauthorizedException } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { ConfigService } from '@nestjs/config';
import { Request } from 'express';
import { AuthService } from './auth.service';

const cookieExtractor = (req: Request) => {
  return req?.cookies?.access_token || null;
};

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor(
    configService: ConfigService,
    private authService: AuthService,
  ) {
    super({
      jwtFromRequest: ExtractJwt.fromExtractors([
        cookieExtractor,
        ExtractJwt.fromAuthHeaderAsBearerToken(),
      ]),
      ignoreExpiration: false,
      secretOrKey: (() => {
        const secret = configService.get<string>('JWT_SECRET');
        if (!secret) {
          throw new Error('JWT_SECRET 环境变量未配置，请设置后再启动服务');
        }
        return secret;
      })(),
    });
  }

  async validate(payload: { sub: string; email: string; role: string }) {
    if (!payload || typeof payload !== 'object') {
      throw new UnauthorizedException('无效的 token 载荷');
    }

    if (!payload.sub || typeof payload.sub !== 'string') {
      throw new UnauthorizedException('Token 缺少有效的用户标识');
    }

    if (!payload.email || typeof payload.email !== 'string') {
      throw new UnauthorizedException('Token 缺少有效的邮箱');
    }

    if (!payload.role || typeof payload.role !== 'string') {
      throw new UnauthorizedException('Token 缺少有效的角色信息');
    }

    const user = await this.authService.validateUser(payload.sub);
    if (!user) {
      throw new UnauthorizedException('用户不存在');
    }
    if (user.isBanned) {
      throw new UnauthorizedException('账号已被封禁');
    }
    return user;
  }
}
