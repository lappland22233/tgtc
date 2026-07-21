import { Controller, Get, Post, Put, Delete, Body, Param, Query, UseGuards, ParseUUIDPipe } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { UserService } from './user.service';
import { Roles } from '../common/decorators/roles.decorator';
import { RolesGuard } from '../common/guards/roles.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { User, UserRole } from '../common/entities/user.entity';
import { CreateUserDto, UpdateRoleDto, BanUserDto, ChangePasswordDto } from './user.dto';

@Controller('users')
@UseGuards(AuthGuard('jwt'), RolesGuard)
export class UserController {
  constructor(private userService: UserService) {}

  @Get()
  @Roles(UserRole.ADMIN, UserRole.SUPER_ADMIN)
  async findAll(
    @Query('page') page = '1',
    @Query('limit') limit = '20',
    @Query('search') search?: string,
  ) {
    // 防御非数字分页参数：Number('abc')=NaN 会传入 .skip(NaN) 致非法 SQL（500）
    const parsedPage = parseInt(String(page), 10);
    const parsedLimit = parseInt(String(limit), 10);
    return this.userService.findAll(
      Number.isFinite(parsedPage) && parsedPage > 0 ? parsedPage : 1,
      Number.isFinite(parsedLimit) && parsedLimit > 0 ? parsedLimit : 20,
      search,
    );
  }

  @Get('me/stats')
  async getMyStats(@CurrentUser() user: User) {
    return this.userService.getUserStats(user.id);
  }

  @Get(':id')
  @Roles(UserRole.ADMIN, UserRole.SUPER_ADMIN)
  async findOne(@Param('id', ParseUUIDPipe) id: string) {
    return this.userService.findOne(id);
  }

  @Post()
  @Roles(UserRole.ADMIN, UserRole.SUPER_ADMIN)
  async create(
    @Body() dto: CreateUserDto,
    @CurrentUser() requester: User,
  ) {
    return this.userService.create(dto, requester);
  }

  @Put(':id/role')
  @Roles(UserRole.SUPER_ADMIN)
  async updateRole(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateRoleDto,
    @CurrentUser() user: User,
  ) {
    await this.userService.updateRole(id, dto.role, user);
    return { message: '角色更新成功' };
  }

  @Put(':id/ban')
  @Roles(UserRole.ADMIN, UserRole.SUPER_ADMIN)
  async banUser(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: BanUserDto,
    @CurrentUser() requester: User,
  ) {
    await this.userService.banUser(id, dto.isBanned, requester);
    return { message: dto.isBanned ? '用户已封禁' : '用户已解封' };
  }

  @Put('me/password')
  async changePassword(
    @CurrentUser() user: User,
    @Body() dto: ChangePasswordDto,
  ) {
    await this.userService.changePassword(user.id, dto.oldPassword, dto.newPassword);
    return { message: '密码修改成功' };
  }

  @Delete(':id')
  @Roles(UserRole.ADMIN, UserRole.SUPER_ADMIN)
  async delete(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() requester: User) {
    await this.userService.delete(id, requester);
    return { message: '用户已删除' };
  }
}
