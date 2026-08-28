import { Global, Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { MediaTicketService } from './media-ticket.service';

@Global()
@Module({
  imports: [ConfigModule],
  providers: [MediaTicketService],
  exports: [MediaTicketService],
})
export class MediaTicketModule {}
