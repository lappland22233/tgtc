import { Injectable, UnauthorizedException } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { ConfigService } from '@nestjs/config';
import { Request } from 'express';
import { AuthService } from './auth.service';
import { UserRole } from '../common/entities/user.entity';
import { ConfigCacheService } from '../common/services/config-cache.service';

const cookieExtractor = (req: Request) => {
  const token = req?.cookies?.access_token;
  // 类型校验：仅返回合法 JWT 格式的 token
  if (!token || typeof token !== 'string' || token.split('.').length !== 3) {
    return null;
  }
  return token;
};

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor(
    configService: ConfigService,
    private authService: AuthService,
    private configCacheService: ConfigCacheService,
  ) {
    // TOKEN_EXTRACTION_MODE 控制 Token 提取方式：
    // - 'cookie_only'：仅从 Cookie 提取（推荐生产环境，缩小攻击面）
    // - 默认（both）：同时支持 Cookie 和 Authorization Header
    const extractionMode = configService.get<string>('TOKEN_EXTRACTION_MODE', 'both');
    const extractors = extractionMode === 'cookie_only'
      ? [cookieExtractor]
      : [cookieExtractor, ExtractJwt.fromAuthHeaderAsBearerToken()];

    super({
      jwtFromRequest: ExtractJwt.fromExtractors(extractors),
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

  async validate(payload: any) {
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

    // 验证角色是否为有效的枚举值，防止伪造角色
    const validRoles = Object.values(UserRole) as string[];
    if (!validRoles.includes(payload.role)) {
      throw new UnauthorizedException('Token 包含无效的角色信息');
    }

    const user = await this.authService.validateUser(payload.sub);
    if (!user) {
      throw new UnauthorizedException('用户不存在或已被删除');
    }

    // Token 吊销检查：若密码在 token 签发之后被修改，则拒绝
    if (user.passwordUpdatedAt && payload.iat) {
      const tokenIssuedAt = new Date(payload.iat * 1000);
      if (user.passwordUpdatedAt > tokenIssuedAt) {
        throw new UnauthorizedException('密码已变更，请重新登录');
      }
    }

    if (user.isBanned) {
      throw new UnauthorizedException('账号已被封禁');
    }
    // 仅在邮箱验证功能开启时才检查 emailVerified，避免功能开关变更后已注册用户被锁定
    const emailVerificationEnabled = await this.configCacheService.get('EMAIL_VERIFICATION_ENABLED', 'false');
    if (emailVerificationEnabled === 'true' && !user.emailVerified) {
      throw new UnauthorizedException('请先验证邮箱');
    }

    // 二次验证：确保 token 中的信息与数据库一致
    if (user.email !== payload.email || user.role !== payload.role) {
      throw new UnauthorizedException('Token 已失效');
    }

    return user;
  }
}
