import { Controller, Post, Body, Get, UseGuards, Req, Res } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { Request, Response } from 'express';
import { AuthService } from './auth.service';
import { RegisterDto, LoginDto, VerifyEmailDto, SendCodeDto, ResetPasswordDto } from './auth.dto';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { User } from '../common/entities/user.entity';
import { getClientIp } from '../common/utils/client-ip';
import { JwtService } from '@nestjs/jwt';
import { RateLimitService } from '../common/services/rate-limit.service';

const getCookieOptions = (req: Request) => ({
  httpOnly: true,
  // 生产环境建议设置 SECURE_COOKIE=true 强制 secure 标志，
  // 避免因反向代理未正确设置 X-Forwarded-Proto 导致 Cookie 降级为非 secure
  secure: process.env.SECURE_COOKIE === 'true' || req.secure || req.headers['x-forwarded-proto'] === 'https',
  // lax: 兼容邮件验证链接等顶级导航跨站场景，安全性仍高于 none
  // （strict 会阻止邮件链接跨站跳转时携带 Cookie，导致用户需重新登录）
  sameSite: 'lax' as const,
  maxAge: 7 * 24 * 3600 * 1000, // 7 days
  path: '/',
});

@Controller('auth')
export class AuthController {
  constructor(
    private readonly authService: AuthService,
    private readonly jwtService: JwtService,
    private readonly rateLimitService: RateLimitService,
  ) {}

  @Post('register')
  async register(@Body() registerDto: RegisterDto, @Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const ip = getClientIp(req);
    const result = await this.authService.register(registerDto, ip);

    if (result.accessToken) {
      res.cookie('access_token', result.accessToken, getCookieOptions(req));
    }

    const { accessToken: _accessToken, ...browserResponse } = result;
    return browserResponse;
  }

  @Post('login')
  async login(@Body() loginDto: LoginDto, @Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const ip = getClientIp(req);
    const result = await this.authService.login(loginDto, ip);
    res.cookie('access_token', result.accessToken, getCookieOptions(req));
    const { accessToken: _accessToken, ...browserResponse } = result;
    return browserResponse;
  }

  @Post('logout')
  async logout(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const token = typeof req.cookies?.access_token === 'string'
      ? req.cookies.access_token
      : undefined;

    // G1-04：仅在 JWT 验签通过后才写入吊销表（防止未验签的伪造 token 膨胀表）。
    // 验签失败/缺失时仅清除 Cookie，不产生任何吊销写。
    if (token) {
      try {
        const payload = this.jwtService.verify(token) as { jti?: string; sub?: string; exp?: number };
        if (payload?.jti && payload.sub && payload.exp) {
          // 吊销写入限量流：同一 IP 高频率 logout 视为可疑，阻止表膨胀与伪造写放大
          const ip = getClientIp(req);
          const limit = await this.rateLimitService.checkAndIncrement(
            `logout-revoke:${ip}`,
            'logout_revoke',
            30,           // 30 次/分钟
            60 * 1000,    // 锁定 1 分钟
            60 * 1000,    // 窗口 1 分钟
          );
          if (limit.allowed) {
            await this.authService.revokeToken(payload.jti, payload.sub, new Date(payload.exp * 1000));
          }
        }
      } catch {
        // token 验签失败（过期/篡改/伪造）：不写入吊销表，仅清除 Cookie
      }
    }
    res.clearCookie('access_token', getCookieOptions(req));
    return { message: '登出成功' };
  }

  @Post('send-code')
  async sendCode(@Body() sendCodeDto: SendCodeDto, @Req() req: Request) {
    const ip = getClientIp(req);
    await this.authService.sendVerificationCode(sendCodeDto, ip);
    return { message: '验证码已发送' };
  }

  @Post('verify-email')
  async verifyEmail(@Body() verifyEmailDto: VerifyEmailDto) {
    await this.authService.verifyEmail(verifyEmailDto);
    return { message: '邮箱验证成功' };
  }

  @Post('reset-password')
  async resetPassword(@Body() dto: ResetPasswordDto, @Req() req: Request) {
    const ip = getClientIp(req);
    await this.authService.resetPassword(dto, ip);
    return { message: '密码重置成功' };
  }

  @Get('me')
  @UseGuards(AuthGuard('jwt'))
  async getMe(@CurrentUser() user: User) {
    return {
      id: user.id,
      email: user.email,
      role: user.role,
      emailVerified: user.emailVerified,
      createdAt: user.createdAt,
    };
  }

  @Get('status')
  async getAuthStatus() {
    return this.authService.getAuthStatus();
  }
}
