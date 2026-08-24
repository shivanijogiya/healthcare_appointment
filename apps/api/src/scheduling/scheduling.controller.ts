import { Body, Controller, Get, Headers, HttpCode, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import type { AuthUser } from '@ham/types';
import { CurrentUser, Roles } from '../common/decorators';
import { SchedulingService } from './scheduling.service';
import { CancelDto, HoldDto, IntakeDto, RescheduleDto } from './dto';

@ApiTags('scheduling')
@ApiBearerAuth()
@Controller('appointments')
export class SchedulingController {
  constructor(private readonly scheduling: SchedulingService) {}

  @Post('hold')
  @Roles('PATIENT')
  @ApiOperation({ summary: 'Hold a slot for the configured TTL while the patient fills the symptom form' })
  @ApiResponse({ status: 201, description: 'Hold placed' })
  @ApiResponse({ status: 409, description: 'SLOT_TAKEN — another patient won the race' })
  hold(
    @CurrentUser() user: AuthUser,
    @Body() dto: HoldDto,
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    return this.scheduling.hold(user, dto, idempotencyKey);
  }

  @Post(':id/intake')
  @Roles('PATIENT')
  @HttpCode(200)
  @ApiOperation({ summary: 'Submit or update the pre-visit symptom form' })
  intake(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: IntakeDto,
  ) {
    return this.scheduling.submitIntake(user, id, dto);
  }

  @Post(':id/confirm')
  @Roles('PATIENT')
  @HttpCode(200)
  @ApiOperation({ summary: 'Turn a live hold into a confirmed appointment' })
  @ApiResponse({ status: 410, description: 'HOLD_EXPIRED' })
  @ApiResponse({ status: 422, description: 'INTAKE_REQUIRED' })
  confirm(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.scheduling.confirm(user, id);
  }

  @Post(':id/cancel')
  @HttpCode(200)
  @ApiOperation({ summary: 'Cancel an appointment (patient, owning doctor, or admin)' })
  cancel(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CancelDto,
  ) {
    return this.scheduling.cancel(user, id, dto);
  }

  @Post(':id/reschedule')
  @HttpCode(200)
  @ApiOperation({ summary: 'Move a confirmed appointment to a new slot' })
  reschedule(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: RescheduleDto,
  ) {
    return this.scheduling.reschedule(user, id, dto);
  }

  @Get('me')
  @Roles('PATIENT')
  @ApiOperation({ summary: 'The signed-in patient’s appointments' })
  mine(@CurrentUser() user: AuthUser) {
    return this.scheduling.listForPatient(user);
  }

  @Get(':id')
  @ApiOperation({ summary: 'A single appointment the caller is party to' })
  one(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.scheduling.getOne(user, id);
  }
}
