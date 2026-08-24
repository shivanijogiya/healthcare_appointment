import { Module } from '@nestjs/common';
import { SchedulingService } from './scheduling.service';
import { SlotsService } from './slots.service';
import { LeaveService } from './leave.service';
import { SchedulingController } from './scheduling.controller';
import { LeaveController } from './leave.controller';

@Module({
  controllers: [SchedulingController, LeaveController],
  providers: [SchedulingService, SlotsService, LeaveService],
  exports: [SchedulingService, SlotsService, LeaveService],
})
export class SchedulingModule {}
