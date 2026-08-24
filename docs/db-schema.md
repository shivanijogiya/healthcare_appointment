# Database schema

PostgreSQL 16. The schema lives in hand-written SQL migrations under
`packages/db/migrations/`, applied in filename order by `npm run migrate` and
tracked in a `_migration` table. Kysely types in `packages/db/src/schema.ts`
mirror it and give the API compile-time safety.

Raw SQL rather than an ORM DSL is deliberate: the constraint that prevents double
booking cannot be expressed by any ORM's schema language, and a reviewer can read
exactly what the database will do.

```
app_user ──1:1── doctor ──┬── doctor_availability
    │                     ├── doctor_leave
    │                     └── appointment ──┬── symptom_intake
    └──1:1── patient ──────────────┘        ├── pre_visit_summary
                                            └── visit_note ──┬── prescription ── medication_reminder
                                                             └── post_visit_summary

notification_outbox   (standalone)
audit_log             (standalone)
refresh_token         (→ app_user)
```

## Identity

**`app_user`** — one row per human. `role` is `PATIENT | DOCTOR | ADMIN`.
Passwords are bcrypt hashes. `doctor` and `patient` hang off it 1:1, so a person
has exactly one identity regardless of role.

**`refresh_token`** — stores a SHA-256 hash, never the token. Rotated on every
use and revoked on rotation, so a stolen refresh token is detectable.

## Scheduling

**`doctor_availability`** — the weekly pattern. `weekday` 0–6 (0 = Sunday),
`start_time` / `end_time` as clinic-local wall clock (`"09:00"`), with
`effective_from` / `effective_to` so hours can change without rewriting history.
Slots are never materialised from this; they are computed on read.

**`doctor_leave`** — `PROPOSED → APPLIED`, or `CANCELLED` if withdrawn. Only
`APPLIED` leave blocks slots, which is what makes the two-phase flow possible.

**`appointment`** — the centre of the system.

| Column | Purpose |
|---|---|
| `state` | `HELD → CONFIRMED → COMPLETED`, or `CANCELLED` / `NO_SHOW` |
| `hold_expires_at` | Set only while `HELD`; a `CHECK` enforces that correspondence |
| `idempotency_key` | Unique; a retried hold returns the original |
| `rescheduled_from_id` | Self-reference preserving the chain across a move |
| `gcal_doctor_event_id`, `gcal_patient_event_id` | Calendar event ids per side |

### The constraint that matters

```sql
ALTER TABLE appointment ADD CONSTRAINT no_double_booking
  EXCLUDE USING gist (
    doctor_id WITH =,
    tstzrange(starts_at, ends_at, '[)') WITH &&
  ) WHERE (state IN ('HELD', 'CONFIRMED'));
```

`btree_gist` is required so a uuid equality operator can share a GiST index with
a range overlap operator.

- `'[)'` bounds — touching ranges do not overlap, so back-to-back slots are legal.
- Partial `WHERE` — cancelled and completed rows leave the index, so a cancelled
  slot is instantly rebookable while history is retained rather than deleted.
- A sibling constraint, `no_patient_overlap`, stops one patient booking two
  doctors at the same time.

Violations raise SQLSTATE `23P01`, mapped to `409 SLOT_TAKEN`.

## Clinical

**`symptom_intake`** — one per appointment, submitted before confirmation.
Carries the patient's own words plus duration, self-reported severity, current
medication and allergies.

**`pre_visit_summary`** — the AI triage output. `status` is
`PENDING | SUCCESS | FAILED | SKIPPED`; `urgency` is `LOW | MEDIUM | HIGH`;
`questions` is a `text[]` of exactly three. `prompt_version`, `model`,
`latency_ms`, `attempts` and `error_message` make every generation traceable and
every failure diagnosable. A row always exists after a generation attempt —
"we tried and failed" is information the doctor's screen needs, whereas a missing
row is ambiguous.

**`visit_note`** — clinical notes, diagnosis and follow-up date. One per
appointment, enforced by a unique constraint.

**`prescription`** — `frequency` is constrained to `OD | BD | TDS | QID | SOS`,
which drives the reminder fan-out. **`post_visit_summary`** mirrors
`pre_visit_summary` for the patient-facing version.

**`medication_reminder`** — one row per dose, expanded at write time from
frequency × duration and capped at 90 days. `UNIQUE (prescription_id, fire_at)`
makes a replayed fan-out job a no-op instead of a duplicate reminder storm. A
partial index on `fire_at WHERE sent = false` keeps the due-reminder query cheap
as the table grows.

## Infrastructure

**`notification_outbox`** — the transactional outbox. Rows are written in the
same transaction as the business change they describe.

| Column | Purpose |
|---|---|
| `dedupe_key` | Unique. The same key twice produces one email, ever |
| `state` | `PENDING → SENDING → SENT`, or `DEAD` once retries are exhausted |
| `attempts`, `last_error` | Drive the backoff ladder and the admin console |
| `scheduled_for` | Lets a T-24h reminder be written at confirm time |
| `locked_at` | Detects a worker that died mid-send |

Drained with `FOR UPDATE SKIP LOCKED`, so replicas never send twice.

**`audit_log`** — actor, action, entity and JSON metadata for every state change.
Writes are best-effort and never fail a business operation.

## Conventions

- `uuid` primary keys via `gen_random_uuid()` — no id enumeration, and ids can be
  generated client-side if ever needed.
- Every instant is `timestamptz`. Wall-clock strings appear only in
  `doctor_availability`, and the conversion lives in exactly one module
  (`slot-math.ts`).
- `numeric(10,2)` for money, read as a string to avoid float drift.
- Foreign keys cascade from the owning aggregate; `appointment` never cascades
  from a deleted user, so clinical history survives.
- `updated_at` is maintained by trigger rather than application discipline.
