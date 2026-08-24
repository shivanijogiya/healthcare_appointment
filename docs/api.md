# API

Base URL `http://localhost:3000`. Interactive OpenAPI at **`/api/docs`**,
generated from the code — treat it as the reference; this page explains intent.

## Conventions

Bearer JWT on everything except `/auth/*`, `/health` and the OAuth callback.
Access tokens last 15 minutes; the web client rotates them transparently.

Errors always carry a stable `code`. Clients branch on the code, never on prose.

```json
{ "code": "SLOT_TAKEN",
  "message": "That slot has just been taken. Pick another time.",
  "requestId": "5f2c…" }
```

| Code | Status | Meaning |
|---|---|---|
| `SLOT_TAKEN` | 409 | Another patient won the race |
| `SLOT_UNAVAILABLE` | 409 | Not a slot this doctor offers, or in the past, or on leave |
| `HOLD_EXPIRED` | 410 | The ten-minute hold lapsed before confirmation |
| `INTAKE_REQUIRED` | 422 | Confirmation attempted before the symptom form |
| `LEAVE_CONFLICT` | 409 | A replacement slot clashed — **nothing was applied** |
| `PATIENT_DOUBLE_BOOKED` | 409 | The patient already has an overlapping appointment |
| `FORBIDDEN_RESOURCE` | 403 | Wrong role, or someone else's record |
| `VALIDATION_FAILED` | 400 | DTO validation; `details` lists the fields |

`Idempotency-Key` is accepted on POSTs. On `/appointments/hold` a repeated key
returns the original hold rather than creating a second one.

## Auth

| Method | Path | Notes |
|---|---|---|
| `POST` | `/auth/register` | Patients only. Doctors and admins are created by an admin |
| `POST` | `/auth/login` | Returns access + refresh tokens and the user |
| `POST` | `/auth/refresh` | Single-use: rotating revokes the old token |
| `POST` | `/auth/logout` | Revokes a refresh token |
| `GET` | `/auth/me` | The signed-in user with role-scoped ids |

## Doctors

| Method | Path | Role |
|---|---|---|
| `GET` | `/doctors?specialisation=&q=` | any |
| `GET` | `/doctors/specialisations` | any |
| `GET` | `/doctors/:id` | any |
| `GET` | `/doctors/:id/slots?date=YYYY-MM-DD` | any |
| `GET` | `/doctors/:id/availability` | any |
| `POST` | `/doctors` | admin |
| `PATCH` | `/doctors/:id` | admin, or the doctor themselves |
| `PUT` | `/doctors/:id/availability` | admin, or the doctor themselves |

`/slots` returns the whole grid including unavailable entries and why, so the UI
can grey out a booked 10:00 rather than silently omitting it:

```json
{ "doctorId": "…", "date": "2026-09-02", "slotDurationMin": 30,
  "slots": [
    { "startsAt": "2026-09-02T03:30:00.000Z", "endsAt": "…", "available": true },
    { "startsAt": "2026-09-02T04:00:00.000Z", "endsAt": "…",
      "available": false, "reason": "BOOKED" }
  ] }
```

`reason` is `BOOKED`, `LEAVE` or `PAST`.

## Booking

| Method | Path | Role |
|---|---|---|
| `POST` | `/appointments/hold` | patient |
| `POST` | `/appointments/:id/intake` | patient |
| `POST` | `/appointments/:id/confirm` | patient |
| `POST` | `/appointments/:id/cancel` | patient, owning doctor, or admin |
| `POST` | `/appointments/:id/reschedule` | patient, owning doctor, or admin |
| `GET` | `/appointments/me` | patient |
| `GET` | `/appointments/:id` | any party to it |

The order is enforced: hold → intake → confirm. Confirming without an intake
returns `INTAKE_REQUIRED`; confirming after the TTL returns `HOLD_EXPIRED`.

A hold emits nothing — no email, no calendar event. Confirmation writes the
outbox rows for both parties and the T-24h reminder in the same transaction as
the state change, then queues the pre-visit summary and the calendar event.

## Doctor workspace

| Method | Path |
|---|---|
| `GET` | `/doctor/appointments?date=` |
| `GET` | `/doctor/appointments/:id/pre-visit` |
| `POST` | `/doctor/appointments/:id/visit-note` |
| `GET` | `/doctor/appointments/:id/visit-note` |

`/pre-visit` returns **both** the summary and the raw intake:

```json
{ "summary": { "status": "SUCCESS", "urgency": "HIGH",
               "chiefComplaint": "Chest pain on exertion, 2 days",
               "questions": ["…", "…", "…"],
               "model": "…", "promptVersion": "v1" },
  "intake":  { "symptomsText": "…", "severity": 8, "allergies": "Penicillin" } }
```

When `status` is `FAILED` or `SKIPPED` the summary fields are null and the intake
is still present, so the doctor is never left with an empty panel.

Filing a visit note marks the appointment `COMPLETED` and queues the post-visit
summary and the medication fan-out. Notes cannot be filed twice.

## Leave

| Method | Path |
|---|---|
| `POST` | `/doctors/:doctorId/leave` |
| `POST` | `/doctors/:doctorId/leave/:leaveId/resolve` |
| `POST` | `/doctors/:doctorId/leave/:leaveId/withdraw` |
| `GET` | `/doctors/:doctorId/leave` |

Phase 1 returns the conflicts and a suggested replacement for each, and commits
nothing to patients. Phase 2 requires a disposition for every conflict:

```json
{ "dispositions": [
    { "appointmentId": "…", "action": "REBOOK_SAME_DOCTOR", "newStartsAt": "…" },
    { "appointmentId": "…", "action": "REASSIGN_DOCTOR",
      "newDoctorId": "…", "newStartsAt": "…" },
    { "appointmentId": "…", "action": "CANCEL" } ] }
```

A missing disposition, or a replacement slot that is already taken, returns
`LEAVE_CONFLICT` and applies **nothing**.

## Patient follow-up

| Method | Path |
|---|---|
| `GET` | `/patients/me/summaries/:appointmentId` |
| `GET` | `/patients/me/visit-notes/:appointmentId` |

The summary sets `"fallback": true` when the AI was unavailable and the content
was derived from prescription rows — the medication plan is complete either way.

## Admin

| Method | Path |
|---|---|
| `GET` | `/admin/overview` |
| `GET` | `/admin/notifications?state=DEAD` |
| `POST` | `/admin/notifications/:id/retry` |
| `GET` | `/admin/appointments?state=` |
| `GET` | `/admin/patients` |
| `GET` | `/admin/audit` |

## Calendar

| Method | Path |
|---|---|
| `GET` | `/calendar/status` |
| `GET` | `/calendar/connect` |
| `GET` | `/calendar/callback` |
| `DELETE` | `/calendar/disconnect` |

## Health

`GET /health` reports database, Redis, the LLM breaker state and outbox counts.
A failing LLM does **not** make the system unhealthy — booking, cancellation and
note submission all work without it. `GET /health/queues` shows queue depths.
