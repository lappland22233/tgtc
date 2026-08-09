import { Module } from '@nestjs/common';
import { JwtModule, JwtModuleOptions } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { JwtStrategy } from './jwt.strategy';
import { User } from '../common/entities/user.entity';
import { VerificationCode } from '../common/entities/verification-code.entity';
import { BannedIP } from '../common/entities/banned-ip.entity';
import { JwtRevokedToken } from '../common/entities/jwt-revoked-token.entity';
import { SystemConfig } from '../common/entities/system-config.entity';
import { MailerModule } from '../mailer/mailer.module';
import { UserModule } from '../user/user.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([User, VerificationCode, BannedIP, JwtRevokedToken, SystemConfig]),
    PassportModule.register({ defaultStrategy: 'jwt' }),
    JwtModule.registerAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (configService: ConfigService): JwtModuleOptions => {
        const secret = configService.get<string>('JWT_SECRET');
        if (!secret) {
          throw new Error('JWT_SECRET 环境变量未配置，无法启动认证模块');
        }
        return {
          secret,
          signOptions: {
            expiresIn: (configService.get<string>('JWT_EXPIRES_IN') || '7d') as NonNullable<JwtModuleOptions['signOptions']>['expiresIn'],
            // 显式声明签名算法，避免依赖库默认值并防止算法混淆
            algorithm: 'HS256',
          },
        };
      },
    }),
    UserModule,
    MailerModule,
  ],
  controllers: [AuthController],
  providers: [AuthService, JwtStrategy],
  exports: [AuthService, JwtModule],
})
export class AuthModule {}
