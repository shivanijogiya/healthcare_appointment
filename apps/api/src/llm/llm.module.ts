import { Global, Module } from '@nestjs/common';
import { LlmService } from './llm.service';
import { SummaryService } from './summary.service';

@Global()
@Module({
  providers: [LlmService, SummaryService],
  exports: [LlmService, SummaryService],
})
export class LlmModule {}
