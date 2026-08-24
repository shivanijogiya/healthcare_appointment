import { Module } from '@nestjs/common';
import { JobRunner } from './job-runner.service';
import { VisitsModule } from '../visits/visits.module';
import { SchedulingModule } from '../scheduling/scheduling.module';

@Module({
  imports: [VisitsModule, SchedulingModule],
  providers: [JobRunner],
})
export class JobsModule {}
