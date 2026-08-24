import { Module } from '@nestjs/common';
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { JwtModule } from '@nestjs/jwt';
import { DbModule } from './db/db.module';
import { CommonModule } from './common/common.module';
import { QueueModule } from './queue/queue.module';
import { NotificationsModule } from './notifications/notifications.module';
import { LlmModule } from './llm/llm.module';
import { CalendarModule } from './calendar/calendar.module';
import { AuthModule } from './auth/auth.module';
import { DoctorsModule } from './doctors/doctors.module';
import { SchedulingModule } from './scheduling/scheduling.module';
import { VisitsModule } from './visits/visits.module';
import { AdminModule } from './admin/admin.module';
import { HealthModule } from './health/health.module';
import { JwtAuthGuard } from './common/guards/jwt-auth.guard';
import { RolesGuard } from './common/guards/roles.guard';
import { AllExceptionsFilter } from './common/filters/all-exceptions.filter';
import { RequestIdInterceptor } from './common/interceptors/request-id.interceptor';

/**
 * A modular monolith. Scheduling knows nothing about email, calendars or
 * models: it writes outbox rows and enqueues jobs, and the other modules pick
 * that work up. That boundary is what makes each integration independently
 * failable rather than something a try/catch has to defend.
 */
@Module({
  imports: [
    DbModule,
    CommonModule,
    QueueModule,
    JwtModule.register({}),
    NotificationsModule,
    LlmModule,
    CalendarModule,
    AuthModule,
    DoctorsModule,
    SchedulingModule,
    VisitsModule,
    AdminModule,
    HealthModule,
  ],
  providers: [
    // Authentication is on by default; @Public() opts an endpoint out.
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    { provide: APP_GUARD, useClass: RolesGuard },
    { provide: APP_FILTER, useClass: AllExceptionsFilter },
    { provide: APP_INTERCEPTOR, useClass: RequestIdInterceptor },
  ],
})
export class AppModule {}
