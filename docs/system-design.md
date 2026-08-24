# System design

Four problems decide whether a clinic booking system is trustworthy: two people
must never get the same slot, a patient must have time to fill in a symptom form
without losing it, a doctor going on leave must never silently strand patients,
and a notification must never vanish.

## Double-booking prevention

Every live appointment is guarded by a Postgres exclusion constraint:

```sql
ALTER TABLE appointment ADD CONSTRAINT no_double_booking
  EXCLUDE USING gist (
    doctor_id WITH =,
    tstzrange(starts_at, ends_at, '[)') WITH &&
  ) WHERE (state IN ('HELD', 'CONFIRMED'));
```

There is no application-level locking anywhere in the booking path — no
`SELECT ... FOR UPDATE`, no advisory locks, no Redis mutex. The service inserts
and lets the database arbitrate. Postgres evaluates the constraint inside the
same lock that performs the write, so the check-then-act race that application
locking exists to paper over never opens.

Application locks are correct only while every writer remembers to take them; a
constraint is correct for every writer forever, including a migration script or
a psql session, and it holds across any number of API instances with no
coordination between them.

Three details are load-bearing. The `'[)'` bounds make touching ranges
non-overlapping, so a 09:15 end and a 09:15 start are legal — that is what makes
a back-to-back slot grid work at all. The partial `WHERE` clause keeps
`CANCELLED` and `COMPLETED` rows out of the index, so cancelling frees the slot
instantly while history is retained rather than deleted. And a second constraint,
`no_patient_overlap`, stops one patient booking two doctors at the same time.

A violation raises SQLSTATE `23P01`, which the service maps to `409 SLOT_TAKEN`.
The concurrency test fires 50 simultaneous holds from 50 distinct patients at one
slot: exactly one 201, exactly 49 SLOT_TAKEN, exactly one row in the database,
in 334ms.

## Slot hold mechanism

The brief requires a symptom form before confirmation. That takes minutes, and
unprotected, two patients could both complete it for the same slot and one would
lose the work. So booking is two-phase: `POST /appointments/hold` writes a `HELD`
row with a ten-minute `hold_expires_at`, and `POST /appointments/:id/confirm`
promotes it.

A hold is not a booking: it sends no email and creates no calendar event, so a
patient who abandons the form never receives a confirmation for an appointment
they did not make.

Expiry is enforced twice, and neither path depends on a background job running on
time. Slot computation ignores any `HELD` row whose `hold_expires_at` has passed,
so a stale hold never blocks a booking. Confirmation runs `UPDATE ... WHERE
state='HELD' AND hold_expires_at > now()`; zero rows affected means `410
HOLD_EXPIRED`. The sweeper that deletes expired holds every 30 seconds is
housekeeping — if it never ran, the system would still book correctly and merely
accumulate dead rows.

## Doctor leave conflict handling

Marking a doctor unavailable is trivial; stranding eight booked patients is the
actual problem, and a system that cancels first and asks later has already sent
the emails by the time anyone notices. Leave is therefore two-phase.

`POST /doctors/:id/leave` records the request as `PROPOSED` and returns the
appointments it would disrupt with a suggested replacement slot for each.
Nothing is committed to any patient. `POST /leave/:id/resolve` takes an explicit
disposition for every conflict — `REBOOK_SAME_DOCTOR`, `REASSIGN_DOCTOR` or
`CANCEL` — and applies them in one transaction. A missing disposition is
rejected, so no patient can be forgotten.

Each replacement booking is an ordinary insert, subject to the same exclusion
constraint, so a rebook can itself lose a race. The entire transaction then rolls
back and the admin is told which one failed. Partial application is not
permitted: a half-applied leave leaves the doctor unavailable with patients still
booked, which is worse than no change at all. The test proves this by occupying a
target slot and confirming a `CANCEL` in the same request does not take effect.

## Notification failure handling

Business state and notification intent commit together. Confirming an
appointment writes the state change and the outbox rows for both parties, plus
the T-24h reminder, in one transaction. There is no window in which an
appointment exists but its confirmation was lost to a crash between `COMMIT` and
the SMTP call.

A worker drains the table with `SELECT ... FOR UPDATE SKIP LOCKED`, so replicas
drain concurrently without ever sending twice. Failures follow a five-step ladder
— immediate, +1m, +5m, +30m, +2h — after which the row becomes `DEAD` and appears
in the admin console with the error and a one-click retry. Hard bounces skip
straight to `DEAD`. Every row carries a unique `dedupe_key`, so a replayed
transaction or crashed worker cannot duplicate a send. A reminder whose
appointment has already started, or been cancelled, is dropped rather than
delivered late.

The same principle governs the LLM: no model call sits on the critical path of
booking, cancellation or note submission. With the summariser offline the doctor
sees the raw symptom intake and the patient still receives a complete medication
plan rendered from prescription rows.
