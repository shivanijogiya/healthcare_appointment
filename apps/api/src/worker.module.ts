import { Module } from '@nestjs/common';
import { DbModule } from './db/db.module';
import { CommonModule } from './common/common.module';
import { QueueModule } from './queue/queue.module';
import { NotificationsModule } from './notifications/notifications.module';
import { LlmModule } from './llm/llm.module';
import { CalendarModule } from './calendar/calendar.module';
import { JobsModule } from './jobs/jobs.module';

/** The worker shares every module with the API but registers no HTTP routes. */
@Module({
  imports: [
    DbModule,
    CommonModule,
    QueueModule,
    NotificationsModule,
    LlmModule,
    CalendarModule,
    JobsModule,
  ],
})
export class WorkerModule {}
