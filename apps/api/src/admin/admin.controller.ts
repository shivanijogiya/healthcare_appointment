import { Controller, Get, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import type { AuthUser } from '@ham/types';
import { CurrentUser, Roles } from '../common/decorators';
import { AdminService } from './admin.service';

@ApiTags('admin')
@ApiBearerAuth()
@Controller('admin')
@Roles('ADMIN')
export class AdminController {
  constructor(private readonly admin: AdminService) {}

  @Get('overview')
  @ApiOperation({ summary: 'Counts across appointments, notifications and AI summaries' })
  overview() { return this.admin.overview(); }

  @Get('notifications')
  @ApiOperation({ summary: 'Notification console — filter by state, including DEAD' })
  @ApiQuery({ name: 'state', required: false, enum: ['PENDING', 'SENDING', 'SENT', 'FAILED', 'DEAD'] })
  notifications(@Query('state') state?: string) { return this.admin.notifications(state); }

  @Post('notifications/:id/retry')
  @ApiOperation({ summary: 'Re-queue a dead notification for immediate delivery' })
  retry(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.admin.retryNotification(user, id);
  }

  @Get('appointments')
  @ApiOperation({ summary: 'All appointments across the clinic' })
  @ApiQuery({ name: 'state', required: false })
  appointments(@Query('state') state?: string) { return this.admin.appointments(state); }

  @Get('patients')
  @ApiOperation({ summary: 'Registered patients' })
  patients() { return this.admin.patients(); }

  @Get('audit')
  @ApiOperation({ summary: 'Audit trail, newest first' })
  audit() { return this.admin.auditLog(); }
}
