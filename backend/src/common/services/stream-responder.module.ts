/**
 * StreamResponder 全局模块。
 * 供 file / share controller 等流式响应方直接注入，无需在各模块重复注册。
 */
import { Global, Module } from '@nestjs/common';
import { StreamResponderService } from './stream-responder.service';

@Global()
@Module({
  providers: [StreamResponderService],
  exports: [StreamResponderService],
})
export class StreamResponderModule {}
