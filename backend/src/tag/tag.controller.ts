import {
  Controller,
  Get,
  Post,
  Put,
  Delete,
  Param,
  Body,
  UseGuards,
  ParseUUIDPipe,
} from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { TagService } from './tag.service';
import { CreateTagDto } from './dto/create-tag.dto';
import { UpdateTagDto } from './dto/update-tag.dto';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import type { User } from '../common/entities/user.entity';

@Controller('tags')
@UseGuards(AuthGuard('jwt'))
export class TagController {
  constructor(private readonly tagService: TagService) {}

  @Get()
  async findAll(@CurrentUser() user: User) {
    return this.tagService.findAll(user.id);
  }

  @Post()
  async create(
    @CurrentUser() user: User,
    @Body() dto: CreateTagDto,
  ) {
    return this.tagService.create(user.id, dto);
  }

  @Put(':id')
  async update(
    @CurrentUser() user: User,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateTagDto,
  ) {
    return this.tagService.update(user.id, id, dto);
  }

  @Delete(':id')
  async delete(
    @CurrentUser() user: User,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    await this.tagService.delete(user.id, id);
    return { message: '标签删除成功' };
  }
}
