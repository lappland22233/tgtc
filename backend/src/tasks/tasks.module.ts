import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { TasksService } from './tasks.service';
import { BannedIP } from '../common/entities/banned-ip.entity';

@Module({
  imports: [TypeOrmModule.forFeature([BannedIP])],
  providers: [TasksService],
})
export class TasksModule {}
