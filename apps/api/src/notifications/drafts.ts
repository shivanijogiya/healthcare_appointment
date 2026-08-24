import { NotificationType } from '../common/enums';
import type { OutboxDraft } from './outbox.service';

/** The denormalised view of an appointment that every email template needs. */
export interface AppointmentContext {
  appointmentId: string;
  startsAt: Date;
  doctorName: string;
  doctorEmail: string;
  specialisation: string;
  patientName: string;
  patientEmail: string;
}

/**
 * Pure draft builders. Keeping payload construction out of the services means
 * the dedupe keys — the thing standing between a retry and a duplicate email —
 * are all declared in one readable place.
 */
export function bookingConfirmed(ctx: AppointmentContext, when: string): OutboxDraft[] {
  const shared = {
    doctorName: ctx.doctorName,
    specialisation: ctx.specialisation,
    patientName: ctx.patientName,
    when,
  };
  return [
    {
      type: NotificationType.BOOKING_CONFIRMED_PATIENT,
      recipientEmail: ctx.patientEmail,
      recipientName: ctx.patientName,
      payload: shared,
      dedupeKey: `${ctx.appointmentId}:BOOKING_CONFIRMED_PATIENT`,
    },
    {
      type: NotificationType.BOOKING_CONFIRMED_DOCTOR,
      recipientEmail: ctx.doctorEmail,
      recipientName: ctx.doctorName,
      payload: shared,
      dedupeKey: `${ctx.appointmentId}:BOOKING_CONFIRMED_DOCTOR`,
    },
  ];
}

/**
 * The reminder row is written at confirm time with a future scheduled_for, so no
 * scanner has to hunt for "appointments happening tomorrow" — the outbox drain
 * already filters on scheduled_for <= now().
 */
export function reminder24h(ctx: AppointmentContext, when: string, sendAt: Date): OutboxDraft | null {
  if (sendAt.getTime() <= Date.now()) return null; // booked inside the reminder window
  return {
    type: NotificationType.REMINDER_24H,
    recipientEmail: ctx.patientEmail,
    recipientName: ctx.patientName,
    payload: {
      doctorName: ctx.doctorName,
      specialisation: ctx.specialisation,
      patientName: ctx.patientName,
      when,
    },
    dedupeKey: `${ctx.appointmentId}:REMINDER_24H`,
    scheduledFor: sendAt,
  };
}

export function cancelled(ctx: AppointmentContext, when: string, reason?: string | null): OutboxDraft[] {
  const shared = {
    doctorName: ctx.doctorName,
    specialisation: ctx.specialisation,
    patientName: ctx.patientName,
    when,
    reason: reason ?? null,
  };
  return [
    {
      type: NotificationType.CANCELLED_PATIENT,
      recipientEmail: ctx.patientEmail,
      recipientName: ctx.patientName,
      payload: shared,
      dedupeKey: `${ctx.appointmentId}:CANCELLED_PATIENT`,
    },
    {
      type: NotificationType.CANCELLED_DOCTOR,
      recipientEmail: ctx.doctorEmail,
      recipientName: ctx.doctorName,
      payload: shared,
      dedupeKey: `${ctx.appointmentId}:CANCELLED_DOCTOR`,
    },
  ];
}

export function leaveRescheduled(params: {
  appointmentId: string;
  patientEmail: string;
  patientName: string;
  doctorName: string;
  originalWhen: string;
  newWhen?: string | null;
  newDoctorName?: string | null;
  leaveId: string;
}): OutboxDraft {
  return {
    type: NotificationType.LEAVE_RESCHEDULED,
    recipientEmail: params.patientEmail,
    recipientName: params.patientName,
    payload: {
      doctorName: params.doctorName,
      originalWhen: params.originalWhen,
      newWhen: params.newWhen ?? null,
      newDoctorName: params.newDoctorName ?? null,
    },
    // Keyed on the leave too: the same appointment disrupted by two different
    // leave events legitimately warrants two emails.
    dedupeKey: `${params.appointmentId}:LEAVE_RESCHEDULED:${params.leaveId}`,
  };
}

export function leaveSummaryDoctor(params: {
  leaveId: string;
  doctorEmail: string;
  doctorName: string;
  leaveFrom: string;
  leaveTo: string;
  changes: string[];
}): OutboxDraft {
  return {
    type: NotificationType.LEAVE_SUMMARY_DOCTOR,
    recipientEmail: params.doctorEmail,
    recipientName: params.doctorName,
    payload: {
      leaveFrom: params.leaveFrom,
      leaveTo: params.leaveTo,
      affectedCount: params.changes.length,
      changes: params.changes,
    },
    dedupeKey: `${params.leaveId}:LEAVE_SUMMARY_DOCTOR`,
  };
}

export function postVisitSummary(params: {
  visitNoteId: string;
  patientEmail: string;
  patientName: string;
  summaryText: string | null;
  medications: string[];
  followUpSteps: string[];
  followUpDate?: string | null;
  /** True when the LLM failed and this was built from prescription rows. */
  degraded: boolean;
}): OutboxDraft {
  return {
    type: NotificationType.POST_VISIT_SUMMARY,
    recipientEmail: params.patientEmail,
    recipientName: params.patientName,
    payload: {
      summaryText: params.summaryText,
      medications: params.medications,
      followUpSteps: params.followUpSteps,
      followUpDate: params.followUpDate ?? null,
      degraded: params.degraded,
    },
    // Not keyed on degraded: the patient gets one summary email, and if the LLM
    // later succeeds we deliberately do not send a second, near-identical one.
    dedupeKey: `${params.visitNoteId}:POST_VISIT_SUMMARY`,
  };
}

export function medicationReminder(params: {
  reminderId: string;
  patientEmail: string;
  patientName: string;
  drugName: string;
  dosage: string;
  instructions?: string | null;
  doctorName: string;
  courseEnds: string;
}): OutboxDraft {
  return {
    type: NotificationType.MEDICATION,
    recipientEmail: params.patientEmail,
    recipientName: params.patientName,
    payload: {
      drugName: params.drugName,
      dosage: params.dosage,
      instructions: params.instructions ?? null,
      doctorName: params.doctorName,
      courseEnds: params.courseEnds,
    },
    dedupeKey: `${params.reminderId}:MEDICATION`,
  };
}
