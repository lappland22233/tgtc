import { Body, Controller, Get, Header, HttpCode, Param, ParseUUIDPipe, Post, Query, Req, UseGuards } from '@nestjs/common';
import type { Request } from 'express';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import { User, UserRole } from '../common/entities/user.entity';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import {
  BanTelegramUserDto, BotGrantsQuery, BotOperationsTimePage, BotOperationsUserParams,
  BotOverviewQuery, BotQueueQuery, BotUserGroupsQuery,
} from './telegram-bot-operations.dto';
import { TelegramBotOperationsService } from './telegram-bot-operations.service';

@Controller('admin/bot-operations')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.SUPER_ADMIN)
export class TelegramBotOperationsController {
  constructor(private readonly operations: TelegramBotOperationsService) {}

  @Get('overview')
  overview(@Query() query: BotOverviewQuery) {
    return this.operations.overview(query);
  }

  @Get('queue')
  queue(@Query() query: BotQueueQuery) {
    return this.operations.listQueue(query);
  }

  @Get('user-groups')
  userGroups(@Query() query: BotUserGroupsQuery) {
    return this.operations.userGroups(query);
  }

  @Post('queue/:id/cancel')
  @HttpCode(200)
  cancel(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() operator: User) {
    return this.operations.cancel(id, operator.id);
  }

  @Get('grants')
  grants(@Query() query: BotGrantsQuery) {
    return this.operations.listGrants(query);
  }

  @Get('grants/:id/link')
  @Header('Cache-Control', 'private, no-store')
  link(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() operator: User, @Req() req: Request) {
    return this.operations.reveal(id, operator.id, req);
  }

  @Post('grants/:id/revoke')
  @HttpCode(200)
  revoke(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() operator: User) {
    return this.operations.revoke(id, operator.id);
  }

  @Get('users/:telegramUserId')
  user(@Param() params: BotOperationsUserParams) {
    return this.operations.userDetails(params.telegramUserId);
  }

  @Get('users/:telegramUserId/audit')
  audit(@Param() params: BotOperationsUserParams, @Query() page: BotOperationsTimePage) {
    return this.operations.userAudit(params.telegramUserId, page);
  }

  @Post('users/:telegramUserId/ban')
  @HttpCode(200)
  ban(@Param() params: BotOperationsUserParams, @Body() body: BanTelegramUserDto, @CurrentUser() operator: User) {
    return this.operations.ban(params.telegramUserId, body.reason, operator.id);
  }
}
