import type { ColumnType, Generated, Insertable, Selectable, Updateable } from 'kysely';

export type Role = 'PATIENT' | 'DOCTOR' | 'ADMIN';
export type AppointmentState = 'HELD' | 'CONFIRMED' | 'CANCELLED' | 'COMPLETED' | 'NO_SHOW';
export type Urgency = 'LOW' | 'MEDIUM' | 'HIGH';
export type LlmStatus = 'PENDING' | 'SUCCESS' | 'FAILED' | 'SKIPPED';
export type OutboxState = 'PENDING' | 'SENDING' | 'SENT' | 'FAILED' | 'DEAD';
export type LeaveStatus = 'PROPOSED' | 'APPLIED' | 'CANCELLED';
export type Frequency = 'OD' | 'BD' | 'TDS' | 'QID' | 'SOS';

type Ts = ColumnType<Date, Date | string | undefined, Date | string>;
type TsNull = ColumnType<Date | null, Date | string | null, Date | string | null>;

export interface AppUserTable {
  id: Generated<string>;
  email: string;
  password_hash: string;
  role: Role;
  name: string;
  phone: string | null;
  created_at: Generated<Date>;
}

export interface DoctorTable {
  id: Generated<string>;
  user_id: string;
  specialisation: string;
  qualification: string | null;
  slot_duration_min: Generated<number>;
  consult_fee: ColumnType<string | null, number | string | null, number | string | null>;
  bio: string | null;
  gcal_refresh_token: string | null;
  gcal_calendar_id: string | null;
  gcal_connected_at: TsNull;
  created_at: Generated<Date>;
}

export interface PatientTable {
  id: Generated<string>;
  user_id: string;
  date_of_birth: ColumnType<Date | null, string | Date | null, string | Date | null>;
  gender: string | null;
  gcal_refresh_token: string | null;
  gcal_calendar_id: string | null;
  gcal_connected_at: TsNull;
  created_at: Generated<Date>;
}

export interface RefreshTokenTable {
  id: Generated<string>;
  user_id: string;
  token_hash: string;
  expires_at: Ts;
  revoked_at: TsNull;
  created_at: Generated<Date>;
}

export interface DoctorAvailabilityTable {
  id: Generated<string>;
  doctor_id: string;
  weekday: number;
  start_time: string;
  end_time: string;
  effective_from: ColumnType<Date, string | Date | undefined, string | Date>;
  effective_to: ColumnType<Date | null, string | Date | null, string | Date | null>;
  created_at: Generated<Date>;
}

export interface DoctorLeaveTable {
  id: Generated<string>;
  doctor_id: string;
  starts_at: Ts;
  ends_at: Ts;
  reason: string | null;
  status: Generated<LeaveStatus>;
  created_by: string | null;
  applied_at: TsNull;
  created_at: Generated<Date>;
}

export interface AppointmentTable {
  id: Generated<string>;
  doctor_id: string;
  patient_id: string;
  starts_at: Ts;
  ends_at: Ts;
  state: AppointmentState;
  hold_expires_at: TsNull;
  idempotency_key: string | null;
  cancel_reason: string | null;
  cancelled_by: string | null;
  rescheduled_from_id: string | null;
  gcal_doctor_event_id: string | null;
  gcal_patient_event_id: string | null;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export interface SymptomIntakeTable {
  id: Generated<string>;
  appointment_id: string;
  symptoms_text: string;
  duration_days: number | null;
  severity: number | null;
  existing_meds: string | null;
  allergies: string | null;
  submitted_at: Generated<Date>;
}

export interface PreVisitSummaryTable {
  id: Generated<string>;
  appointment_id: string;
  urgency: Urgency | null;
  chief_complaint: string | null;
  questions: Generated<string[]>;
  raw_response: string | null;
  model: string | null;
  prompt_version: string;
  status: Generated<LlmStatus>;
  error_message: string | null;
  latency_ms: number | null;
  attempts: Generated<number>;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export interface VisitNoteTable {
  id: Generated<string>;
  appointment_id: string;
  doctor_id: string;
  clinical_notes: string;
  diagnosis: string | null;
  follow_up_date: ColumnType<Date | null, string | Date | null, string | Date | null>;
  submitted_at: Generated<Date>;
}

export interface PrescriptionTable {
  id: Generated<string>;
  visit_note_id: string;
  drug_name: string;
  dosage: string;
  frequency: Frequency;
  duration_days: number;
  instructions: string | null;
}

export interface PostVisitSummaryTable {
  id: Generated<string>;
  visit_note_id: string;
  summary_text: string | null;
  med_schedule: ColumnType<unknown | null, string | null, string | null>;
  follow_up_steps: Generated<string[]>;
  raw_response: string | null;
  model: string | null;
  prompt_version: string;
  status: Generated<LlmStatus>;
  error_message: string | null;
  latency_ms: number | null;
  attempts: Generated<number>;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export interface MedicationReminderTable {
  id: Generated<string>;
  prescription_id: string;
  patient_id: string;
  fire_at: Ts;
  sent: Generated<boolean>;
}

export interface NotificationOutboxTable {
  id: Generated<string>;
  recipient_email: string;
  recipient_name: string | null;
  type: string;
  payload: ColumnType<any, string, string>;
  dedupe_key: string;
  scheduled_for: Generated<Date>;
  state: Generated<OutboxState>;
  attempts: Generated<number>;
  last_error: string | null;
  provider_msg_id: string | null;
  locked_at: TsNull;
  sent_at: TsNull;
  created_at: Generated<Date>;
}

export interface AuditLogTable {
  id: Generated<string>;
  actor_id: string | null;
  actor_role: Role | null;
  action: string;
  entity: string;
  entity_id: string | null;
  metadata: ColumnType<any, string | null, string | null>;
  created_at: Generated<Date>;
}

export interface Database {
  app_user: AppUserTable;
  doctor: DoctorTable;
  patient: PatientTable;
  refresh_token: RefreshTokenTable;
  doctor_availability: DoctorAvailabilityTable;
  doctor_leave: DoctorLeaveTable;
  appointment: AppointmentTable;
  symptom_intake: SymptomIntakeTable;
  pre_visit_summary: PreVisitSummaryTable;
  visit_note: VisitNoteTable;
  prescription: PrescriptionTable;
  post_visit_summary: PostVisitSummaryTable;
  medication_reminder: MedicationReminderTable;
  notification_outbox: NotificationOutboxTable;
  audit_log: AuditLogTable;
}

export type AppUser = Selectable<AppUserTable>;
export type Doctor = Selectable<DoctorTable>;
export type Patient = Selectable<PatientTable>;
export type Appointment = Selectable<AppointmentTable>;
export type NewAppointment = Insertable<AppointmentTable>;
export type AppointmentUpdate = Updateable<AppointmentTable>;
export type DoctorAvailability = Selectable<DoctorAvailabilityTable>;
export type DoctorLeave = Selectable<DoctorLeaveTable>;
export type SymptomIntake = Selectable<SymptomIntakeTable>;
export type PreVisitSummary = Selectable<PreVisitSummaryTable>;
export type VisitNote = Selectable<VisitNoteTable>;
export type Prescription = Selectable<PrescriptionTable>;
export type PostVisitSummary = Selectable<PostVisitSummaryTable>;
export type NotificationOutbox = Selectable<NotificationOutboxTable>;
