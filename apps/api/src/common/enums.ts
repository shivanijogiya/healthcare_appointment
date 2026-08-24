/**
 * Domain enums declared locally so the codebase compiles before
 * `prisma generate` runs. Values are identical to the Prisma enums and are
 * structurally assignable to them.
 */
export const Role = { PATIENT: 'PATIENT', DOCTOR: 'DOCTOR', ADMIN: 'ADMIN' } as const;
export type Role = (typeof Role)[keyof typeof Role];

export const AppointmentState = {
  HELD: 'HELD',
  CONFIRMED: 'CONFIRMED',
  CANCELLED: 'CANCELLED',
  COMPLETED: 'COMPLETED',
  NO_SHOW: 'NO_SHOW',
} as const;
export type AppointmentState = (typeof AppointmentState)[keyof typeof AppointmentState];

export const Urgency = { LOW: 'LOW', MEDIUM: 'MEDIUM', HIGH: 'HIGH' } as const;
export type Urgency = (typeof Urgency)[keyof typeof Urgency];

export const LlmStatus = {
  PENDING: 'PENDING',
  SUCCESS: 'SUCCESS',
  FAILED: 'FAILED',
  SKIPPED: 'SKIPPED',
} as const;
export type LlmStatus = (typeof LlmStatus)[keyof typeof LlmStatus];

export const OutboxState = {
  PENDING: 'PENDING',
  SENDING: 'SENDING',
  SENT: 'SENT',
  FAILED: 'FAILED',
  DEAD: 'DEAD',
} as const;
export type OutboxState = (typeof OutboxState)[keyof typeof OutboxState];

export const LeaveStatus = {
  PROPOSED: 'PROPOSED',
  APPLIED: 'APPLIED',
  CANCELLED: 'CANCELLED',
} as const;
export type LeaveStatus = (typeof LeaveStatus)[keyof typeof LeaveStatus];

export const NotificationType = {
  BOOKING_CONFIRMED_PATIENT: 'BOOKING_CONFIRMED_PATIENT',
  BOOKING_CONFIRMED_DOCTOR: 'BOOKING_CONFIRMED_DOCTOR',
  REMINDER_24H: 'REMINDER_24H',
  CANCELLED_PATIENT: 'CANCELLED_PATIENT',
  CANCELLED_DOCTOR: 'CANCELLED_DOCTOR',
  LEAVE_RESCHEDULED: 'LEAVE_RESCHEDULED',
  LEAVE_SUMMARY_DOCTOR: 'LEAVE_SUMMARY_DOCTOR',
  POST_VISIT_SUMMARY: 'POST_VISIT_SUMMARY',
  MEDICATION: 'MEDICATION',
} as const;
export type NotificationType = (typeof NotificationType)[keyof typeof NotificationType];
