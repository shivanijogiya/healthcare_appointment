import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import type { AuthUser } from '@ham/types';
import { CurrentUser, Roles } from '../common/decorators';
import { VisitsService } from './visits.service';
import { SchedulingService } from '../scheduling/scheduling.service';
import { SummaryService } from '../llm/summary.service';
import { VisitNoteDto } from './dto';

@ApiTags('doctor-workspace')
@ApiBearerAuth()
@Controller('doctor')
@Roles('DOCTOR', 'ADMIN')
export class DoctorWorkspaceController {
  constructor(
    private readonly visits: VisitsService,
    private readonly scheduling: SchedulingService,
    private readonly summaries: SummaryService,
  ) {}

  @Get('appointments')
  @ApiOperation({ summary: 'The doctor’s schedule, optionally for one date' })
  @ApiQuery({ name: 'date', required: false, example: '2026-09-01' })
  schedule(@CurrentUser() user: AuthUser, @Query('date') date?: string) {
    return this.scheduling.listForDoctor(user, date);
  }

  @Get('appointments/:id/pre-visit')
  @ApiOperation({
    summary: 'AI pre-visit summary, with the raw intake as fallback',
    description: 'When the summary status is FAILED or SKIPPED the raw symptom intake is still returned so the doctor is never left with an empty panel.',
  })
  async preVisit(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    await this.scheduling.getOne(user, id); // ownership check
    return this.summaries.preVisitFor(id);
  }

  @Post('appointments/:id/visit-note')
  @ApiOperation({ summary: 'File post-visit notes and prescriptions' })
  submitNote(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: VisitNoteDto,
  ) {
    return this.visits.submitNote(user, id, dto);
  }

  @Get('appointments/:id/visit-note')
  @ApiOperation({ summary: 'Read filed notes for an appointment' })
  note(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.visits.noteForAppointment(user, id);
  }
}

@ApiTags('patient')
@ApiBearerAuth()
@Controller('patients/me')
@Roles('PATIENT')
export class PatientSummariesController {
  constructor(
    private readonly summaries: SummaryService,
    private readonly scheduling: SchedulingService,
    private readonly visits: VisitsService,
  ) {}

  @Get('summaries/:appointmentId')
  @ApiOperation({
    summary: 'Patient-friendly post-visit summary',
    description: 'Falls back to prescription-derived content when the AI summary is unavailable.',
  })
  async summary(
    @CurrentUser() user: AuthUser,
    @Param('appointmentId', ParseUUIDPipe) appointmentId: string,
  ) {
    await this.scheduling.getOne(user, appointmentId);
    return this.summaries.postVisitForAppointment(appointmentId);
  }

  @Get('visit-notes/:appointmentId')
  @ApiOperation({ summary: 'Prescriptions filed for one of the patient’s visits' })
  note(
    @CurrentUser() user: AuthUser,
    @Param('appointmentId', ParseUUIDPipe) appointmentId: string,
  ) {
    return this.visits.noteForAppointment(user, appointmentId);
  }
}
