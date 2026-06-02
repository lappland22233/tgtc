import { IsEmail, IsString, MinLength, MaxLength, IsOptional, IsEnum, IsBoolean } from 'class-validator';
import { UserRole } from '../common/entities/user.entity';

export class CreateUserDto {
  @IsEmail({}, { message: '请输入有效的邮箱地址' })
  email: string;

  @IsString()
  @MinLength(6, { message: '密码至少6位' })
  @MaxLength(20, { message: '密码最多20位' })
  password: string;

  @IsOptional()
  @IsEnum([UserRole.ADMIN, UserRole.USER], { message: '角色无效' })
  role?: UserRole;
}

export class UpdateRoleDto {
  @IsEnum(UserRole, { message: '角色无效' })
  role: UserRole;
}

export class BanUserDto {
  @IsBoolean()
  isBanned: boolean;
}

export class ChangePasswordDto {
  @IsString()
  oldPassword: string;

  @IsString()
  @MinLength(6, { message: '新密码至少6位' })
  @MaxLength(20, { message: '新密码最多20位' })
  newPassword: string;
}
