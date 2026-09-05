import { Controller, Get } from '@nestjs/common';
import { PublicConfigDto } from './public-config.dto';
import { PublicConfigService } from './public-config.service';

@Controller('public-config')
export class PublicConfigController {
  constructor(private readonly publicConfigService: PublicConfigService) {}

  @Get()
  getPublicConfig(): Promise<PublicConfigDto> {
    return this.publicConfigService.getPublicConfig();
  }
}
