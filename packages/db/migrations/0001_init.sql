-- 0001_init.sql — core schema
-- Enums -----------------------------------------------------------------
CREATE TYPE role              AS ENUM ('PATIENT','DOCTOR','ADMIN');
CREATE TYPE appointment_state AS ENUM ('HELD','CONFIRMED','CANCELLED','COMPLETED','NO_SHOW');
CREATE TYPE urgency           AS ENUM ('LOW','MEDIUM','HIGH');
CREATE TYPE llm_status        AS ENUM ('PENDING','SUCCESS','FAILED','SKIPPED');
CREATE TYPE outbox_state      AS ENUM ('PENDING','SENDING','SENT','FAILED','DEAD');
CREATE TYPE leave_status      AS ENUM ('PROPOSED','APPLIED','CANCELLED');

-- Identity --------------------------------------------------------------
CREATE TABLE app_user (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email         text NOT NULL UNIQUE,
  password_hash text NOT NULL,
  role          role NOT NULL,
  name          text NOT NULL,
  phone         text,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX app_user_role_idx ON app_user(role);

CREATE TABLE doctor (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id            uuid NOT NULL UNIQUE REFERENCES app_user(id) ON DELETE CASCADE,
  specialisation     text NOT NULL,
  qualification      text,
  slot_duration_min  int  NOT NULL DEFAULT 15 CHECK (slot_duration_min BETWEEN 5 AND 120),
  consult_fee        numeric(10,2),
  bio                text,
  gcal_refresh_token text,           -- AES-256-GCM ciphertext, never plaintext
  gcal_calendar_id   text,
  gcal_connected_at  timestamptz,
  created_at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX doctor_specialisation_idx ON doctor(specialisation);

CREATE TABLE patient (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id            uuid NOT NULL UNIQUE REFERENCES app_user(id) ON DELETE CASCADE,
  date_of_birth      date,
  gender             text,
  gcal_refresh_token text,
  gcal_calendar_id   text,
  gcal_connected_at  timestamptz,
  created_at         timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE refresh_token (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    uuid NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
  token_hash text NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX refresh_token_user_idx ON refresh_token(user_id);

-- Availability ----------------------------------------------------------
CREATE TABLE doctor_availability (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  doctor_id      uuid NOT NULL REFERENCES doctor(id) ON DELETE CASCADE,
  weekday        int  NOT NULL CHECK (weekday BETWEEN 0 AND 6),  -- 0=Sunday
  start_time     text NOT NULL,   -- "09:00" clinic-local
  end_time       text NOT NULL,   -- "13:00"
  effective_from date NOT NULL DEFAULT CURRENT_DATE,
  effective_to   date,
  created_at     timestamptz NOT NULL DEFAULT now(),
  CHECK (start_time < end_time)
);
CREATE INDEX doctor_availability_lookup_idx ON doctor_availability(doctor_id, weekday);

CREATE TABLE doctor_leave (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  doctor_id  uuid NOT NULL REFERENCES doctor(id) ON DELETE CASCADE,
  starts_at  timestamptz NOT NULL,
  ends_at    timestamptz NOT NULL,
  reason     text,
  status     leave_status NOT NULL DEFAULT 'PROPOSED',
  created_by uuid REFERENCES app_user(id),
  applied_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (starts_at < ends_at)
);
CREATE INDEX doctor_leave_window_idx ON doctor_leave(doctor_id, starts_at, ends_at);

-- Appointments ----------------------------------------------------------
CREATE TABLE appointment (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  doctor_id            uuid NOT NULL REFERENCES doctor(id) ON DELETE CASCADE,
  patient_id           uuid NOT NULL REFERENCES patient(id) ON DELETE CASCADE,
  starts_at            timestamptz NOT NULL,
  ends_at              timestamptz NOT NULL,
  state                appointment_state NOT NULL,
  hold_expires_at      timestamptz,
  idempotency_key      text UNIQUE,
  cancel_reason        text,
  cancelled_by         uuid REFERENCES app_user(id),
  rescheduled_from_id  uuid REFERENCES appointment(id),
  gcal_doctor_event_id  text,
  gcal_patient_event_id text,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  CHECK (starts_at < ends_at),
  -- a HELD row must carry an expiry; a non-HELD row must not
  CHECK ((state = 'HELD') = (hold_expires_at IS NOT NULL))
);
CREATE INDEX appointment_doctor_idx  ON appointment(doctor_id, starts_at);
CREATE INDEX appointment_patient_idx ON appointment(patient_id, starts_at);
CREATE INDEX appointment_sweep_idx   ON appointment(state, hold_expires_at);

-- Clinical --------------------------------------------------------------
CREATE TABLE symptom_intake (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  appointment_id uuid NOT NULL UNIQUE REFERENCES appointment(id) ON DELETE CASCADE,
  symptoms_text  text NOT NULL,
  duration_days  int,
  severity       int CHECK (severity BETWEEN 1 AND 10),
  existing_meds  text,
  allergies      text,
  submitted_at   timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE pre_visit_summary (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  appointment_id  uuid NOT NULL UNIQUE REFERENCES appointment(id) ON DELETE CASCADE,
  urgency         urgency,
  chief_complaint text,
  questions       text[] NOT NULL DEFAULT '{}',
  raw_response    text,
  model           text,
  prompt_version  text NOT NULL,
  status          llm_status NOT NULL DEFAULT 'PENDING',
  error_message   text,
  latency_ms      int,
  attempts        int NOT NULL DEFAULT 0,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE visit_note (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  appointment_id uuid NOT NULL UNIQUE REFERENCES appointment(id) ON DELETE CASCADE,
  doctor_id      uuid NOT NULL REFERENCES doctor(id) ON DELETE CASCADE,
  clinical_notes text NOT NULL,
  diagnosis      text,
  follow_up_date date,
  submitted_at   timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE prescription (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  visit_note_id uuid NOT NULL REFERENCES visit_note(id) ON DELETE CASCADE,
  drug_name     text NOT NULL,
  dosage        text NOT NULL,
  frequency     text NOT NULL CHECK (frequency IN ('OD','BD','TDS','QID','SOS')),
  duration_days int  NOT NULL CHECK (duration_days > 0),
  instructions  text
);
CREATE INDEX prescription_note_idx ON prescription(visit_note_id);

CREATE TABLE post_visit_summary (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  visit_note_id   uuid NOT NULL UNIQUE REFERENCES visit_note(id) ON DELETE CASCADE,
  summary_text    text,
  med_schedule    jsonb,
  follow_up_steps text[] NOT NULL DEFAULT '{}',
  raw_response    text,
  model           text,
  prompt_version  text NOT NULL,
  status          llm_status NOT NULL DEFAULT 'PENDING',
  error_message   text,
  latency_ms      int,
  attempts        int NOT NULL DEFAULT 0,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE medication_reminder (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  prescription_id uuid NOT NULL REFERENCES prescription(id) ON DELETE CASCADE,
  patient_id      uuid NOT NULL REFERENCES patient(id) ON DELETE CASCADE,
  fire_at         timestamptz NOT NULL,
  sent            boolean NOT NULL DEFAULT false,
  UNIQUE (prescription_id, fire_at)
);
CREATE INDEX medication_reminder_due_idx ON medication_reminder(fire_at) WHERE sent = false;

-- Infrastructure --------------------------------------------------------
CREATE TABLE notification_outbox (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  recipient_email text NOT NULL,
  recipient_name  text,
  type            text NOT NULL,
  payload         jsonb NOT NULL,
  dedupe_key      text NOT NULL UNIQUE,
  scheduled_for   timestamptz NOT NULL DEFAULT now(),
  state           outbox_state NOT NULL DEFAULT 'PENDING',
  attempts        int NOT NULL DEFAULT 0,
  last_error      text,
  provider_msg_id text,
  locked_at       timestamptz,
  sent_at         timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX notification_outbox_drain_idx ON notification_outbox(state, scheduled_for);

CREATE TABLE audit_log (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_id   uuid,
  actor_role role,
  action     text NOT NULL,
  entity     text NOT NULL,
  entity_id  text,
  metadata   jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_log_entity_idx ON audit_log(entity, entity_id);
CREATE INDEX audit_log_created_idx ON audit_log(created_at DESC);
