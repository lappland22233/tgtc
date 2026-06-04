import { Controller, Post, Body, Get, UseGuards, Req, Res } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { Request, Response } from 'express';
import { AuthService } from './auth.service';
import { RegisterDto, LoginDto, VerifyEmailDto, SendCodeDto, ResetPasswordDto } from './auth.dto';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { User } from '../common/entities/user.entity';

const getCookieOptions = (req: Request) => ({
  httpOnly: true,
  // 请求级动态判断 HTTPS，兼容反向代理（X-Forwarded-Proto）
  secure: req.secure || req.headers['x-forwarded-proto'] === 'https',
  sameSite: 'strict' as const,
  maxAge: 7 * 24 * 3600 * 1000, // 7 days
  path: '/',
});

@Controller('auth')
export class AuthController {
  constructor(private authService: AuthService) {}

  @Post('register')
  async register(@Body() registerDto: RegisterDto, @Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const ip = req.ip || req.socket?.remoteAddress || 'unknown';
    const result = await this.authService.register(registerDto, ip);

    if (result.accessToken) {
      res.cookie('access_token', result.accessToken, getCookieOptions(req));
    }

    return result;
  }

  @Post('login')
  async login(@Body() loginDto: LoginDto, @Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const ip = req.ip || req.socket?.remoteAddress || 'unknown';
    const result = await this.authService.login(loginDto, ip);
    res.cookie('access_token', result.accessToken, getCookieOptions(req));
    return result;
  }

  @Post('logout')
  async logout(@Res({ passthrough: true }) res: Response) {
    res.clearCookie('access_token', { path: '/' });
    return { message: '登出成功' };
  }

  @Post('send-code')
  async sendCode(@Body() sendCodeDto: SendCodeDto, @Req() req: Request) {
    const ip = req.ip || req.socket?.remoteAddress || 'unknown';
    await this.authService.sendVerificationCode(sendCodeDto, ip);
    return { message: '验证码已发送' };
  }

  @Post('verify-email')
  async verifyEmail(@Body() verifyEmailDto: VerifyEmailDto) {
    await this.authService.verifyEmail(verifyEmailDto);
    return { message: '邮箱验证成功' };
  }

  @Post('reset-password')
  async resetPassword(@Body() dto: ResetPasswordDto) {
    await this.authService.resetPassword(dto);
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
