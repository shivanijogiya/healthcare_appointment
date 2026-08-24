/** Shared contract between the API and the web client. */

export type Role = 'PATIENT' | 'DOCTOR' | 'ADMIN';
export type AppointmentState = 'HELD' | 'CONFIRMED' | 'CANCELLED' | 'COMPLETED' | 'NO_SHOW';
export type Urgency = 'LOW' | 'MEDIUM' | 'HIGH';
export type LlmStatus = 'PENDING' | 'SUCCESS' | 'FAILED' | 'SKIPPED';
export type OutboxState = 'PENDING' | 'SENDING' | 'SENT' | 'FAILED' | 'DEAD';
export type Frequency = 'OD' | 'BD' | 'TDS' | 'QID' | 'SOS';
export type LeaveDisposition = 'REBOOK_SAME_DOCTOR' | 'REASSIGN_DOCTOR' | 'CANCEL';

/** Typed error codes. The API never returns prose as a machine-readable error. */
export const ErrorCode = {
  SLOT_TAKEN: 'SLOT_TAKEN',
  SLOT_UNAVAILABLE: 'SLOT_UNAVAILABLE',
  HOLD_EXPIRED: 'HOLD_EXPIRED',
  INTAKE_REQUIRED: 'INTAKE_REQUIRED',
  LEAVE_CONFLICT: 'LEAVE_CONFLICT',
  PATIENT_DOUBLE_BOOKED: 'PATIENT_DOUBLE_BOOKED',
  LLM_UNAVAILABLE: 'LLM_UNAVAILABLE',
  FORBIDDEN_RESOURCE: 'FORBIDDEN_RESOURCE',
  INVALID_CREDENTIALS: 'INVALID_CREDENTIALS',
  TOKEN_INVALID: 'TOKEN_INVALID',
  VALIDATION_FAILED: 'VALIDATION_FAILED',
  NOT_FOUND: 'NOT_FOUND',
  CONFLICT: 'CONFLICT',
  CALENDAR_NOT_CONNECTED: 'CALENDAR_NOT_CONNECTED',
  INTERNAL: 'INTERNAL',
} as const;
export type ErrorCode = (typeof ErrorCode)[keyof typeof ErrorCode];

export interface ApiError {
  code: ErrorCode;
  message: string;
  details?: unknown;
  requestId?: string;
}

export interface AuthUser {
  id: string;
  email: string;
  name: string;
  role: Role;
  doctorId?: string;
  patientId?: string;
}

export interface AuthResponse {
  accessToken: string;
  refreshToken: string;
  user: AuthUser;
}

export interface DoctorSummary {
  id: string;
  name: string;
  email: string;
  specialisation: string;
  qualification: string | null;
  slotDurationMin: number;
  consultFee: number | null;
  bio: string | null;
  calendarConnected: boolean;
}

export interface Slot {
  startsAt: string;
  endsAt: string;
  available: boolean;
  reason?: 'BOOKED' | 'LEAVE' | 'PAST';
}

export interface AppointmentDto {
  id: string;
  doctorId: string;
  doctorName: string;
  specialisation: string;
  patientId: string;
  patientName: string;
  startsAt: string;
  endsAt: string;
  state: AppointmentState;
  holdExpiresAt: string | null;
  cancelReason: string | null;
  hasIntake: boolean;
  hasVisitNote: boolean;
  calendarSynced: boolean;
}

export interface PreVisitSummaryDto {
  status: LlmStatus;
  urgency: Urgency | null;
  chiefComplaint: string | null;
  questions: string[];
  errorMessage: string | null;
  model: string | null;
  promptVersion: string;
  generatedAt: string | null;
}

export interface MedScheduleEntry {
  drug: string;
  when: string;
  duration: string;
}

export interface PostVisitSummaryDto {
  status: LlmStatus;
  summaryText: string | null;
  medicationSchedule: MedScheduleEntry[];
  followUpSteps: string[];
  errorMessage: string | null;
  /** True when the LLM failed and the patient is seeing prescription-derived content. */
  fallback: boolean;
}

export interface PrescriptionDto {
  id?: string;
  drugName: string;
  dosage: string;
  frequency: Frequency;
  durationDays: number;
  instructions?: string | null;
}

export interface LeaveConflict {
  appointmentId: string;
  startsAt: string;
  endsAt: string;
  patientName: string;
  patientEmail: string;
  state: AppointmentState;
}

export const FREQUENCY_TIMES: Record<Frequency, string[]> = {
  OD: ['09:00'],
  BD: ['09:00', '21:00'],
  TDS: ['08:00', '14:00', '20:00'],
  QID: ['06:00', '12:00', '18:00', '00:00'],
  SOS: [],
};

export const FREQUENCY_LABEL: Record<Frequency, string> = {
  OD: 'Once a day',
  BD: 'Twice a day',
  TDS: 'Three times a day',
  QID: 'Four times a day',
  SOS: 'Only when needed',
};
