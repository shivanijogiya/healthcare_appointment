import { Module } from '@nestjs/common';
import { VisitsService } from './visits.service';
import { DoctorWorkspaceController, PatientSummariesController } from './visits.controller';
import { SchedulingModule } from '../scheduling/scheduling.module';

@Module({
  imports: [SchedulingModule],
  controllers: [DoctorWorkspaceController, PatientSummariesController],
  providers: [VisitsService],
  exports: [VisitsService],
})
export class VisitsModule {}
