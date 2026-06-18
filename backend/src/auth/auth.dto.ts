import { IsEmail, IsString, MinLength, MaxLength, Matches, ValidateIf } from 'class-validator';

export enum VerificationType {
  REGISTER = 'register',
  RESET_PASSWORD = 'reset_password',
}

export class RegisterDto {
  @IsEmail({}, { message: '请输入有效的邮箱地址' })
  email: string;

  @IsString()
  @MinLength(8, { message: '密码至少8位' })
  @MaxLength(128, { message: '密码最多128位' })
  @Matches(/[a-zA-Z]/, { message: '密码必须包含至少一个字母' })
  password: string;

  @ValidateIf((o) => o.code !== undefined && o.code !== null && o.code !== '')
  @IsString()
  @Matches(/^\d{6}$/, { message: '验证码必须是6位数字' })
  code?: string;
}

export class LoginDto {
  @IsEmail({}, { message: '请输入有效的邮箱地址' })
  email: string;

  @IsString()
  @MinLength(1, { message: '请输入密码' })
  password: string;
}

export class SendCodeDto {
  @IsEmail({}, { message: '请输入有效的邮箱地址' })
  email: string;

  @IsString()
  @Matches(/^(register|reset_password)$/, { message: '类型必须是 register 或 reset_password' })
  type: string;
}

export class VerifyEmailDto {
  @IsEmail({}, { message: '请输入有效的邮箱地址' })
  email: string;

  @IsString()
  @Matches(/^\d{6}$/, { message: '验证码必须是6位数字' })
  code: string;
}

export class ResetPasswordDto {
  @IsEmail({}, { message: '请输入有效的邮箱地址' })
  email: string;

  @IsString()
  @Matches(/^\d{6}$/, { message: '验证码必须是6位数字' })
  code: string;

  @IsString()
  @MinLength(8, { message: '密码至少8位' })
  @MaxLength(128, { message: '密码最多128位' })
  @Matches(/[a-zA-Z]/, { message: '密码必须包含至少一个字母' })
  newPassword: string;
}
