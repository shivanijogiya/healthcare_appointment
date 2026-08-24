# Healthcare Appointment & Follow-up Manager

A multi-doctor clinic platform with separate patient, doctor and admin portals.
Patients search doctors, hold a slot, describe their symptoms and confirm.
The doctor gets an AI pre-visit summary with an urgency level; after the visit
the patient gets a plain-language summary and medication reminders. Both sides
are kept informed by email and Google Calendar.

**Start here:** [`SETUP.md`](./SETUP.md) — running locally takes about three minutes.

---

## What is actually verified

Every claim below was produced by running the system, not by inspection.

| Check | Result |
|---|---|
| 50 simultaneous holds on one slot | 1 × `201`, 49 × `409 SLOT_TAKEN`, **1 row in the database**, 334 ms |
| End-to-end clinical flow | 49/49 assertions |
| Doctor leave, two-phase | 23/23 assertions, including all-or-nothing rollback |
| Failure injection (LLM **and** SMTP down) | 17/17 assertions |
| Unit tests | 48/48 |

```
npm install             # also builds the shared @ham/* packages
npm run test:all        # unit + every integration suite
```

---

## Architecture

```
   Patient SPA        Doctor SPA        Admin SPA
        └──────────────────┼──────────────────┘
                           │ HTTPS · JWT
                ┌──────────▼──────────┐
                │      NestJS API     │   guards · validation · idempotency
                └──────────┬──────────┘
          ┌────────────────┼────────────────┐
     ┌────▼─────┐   ┌──────▼──────┐  ┌──────▼──────┐
     │Scheduling│   │     LLM     │  │Notifications│
     │          │   │   breaker   │  │   outbox    │
     └────┬─────┘   └──────┬──────┘  └──────┬──────┘
          └────────┬───────┴────────┬───────┘
          ┌────────▼─────┐   ┌──────▼───────┐
          │  PostgreSQL  │   │    Redis     │
          │ source of    │   │  queues      │
          │ truth        │   │              │
          └──────┬───────┘   └──────┬───────┘
                 │           ┌──────▼───────────┐
                 └──────────►│  Worker process  │
                             │ BullMQ consumers │
                             └──────┬───────────┘
                  ┌─────────────────┼─────────────────┐
                  ▼                 ▼                 ▼
            LLM provider      SMTP provider    Google Calendar
```

**Module boundary rule.** Scheduling knows nothing about email, calendars or
models. It writes outbox rows and enqueues jobs; other modules pick that work up.
That boundary is what makes "LLM failures must not break the system" an
architectural property rather than something a `try/catch` has to defend.

**Two processes, one codebase.** The API never registers a queue consumer, so a
wedged LLM call or a hanging SMTP connection consumes worker capacity and nothing
else. Booking stays responsive while every integration behind it is failing.

---

## The four hard problems

Full reasoning in [`docs/system-design.md`](./docs/system-design.md).

**Double-booking** — a Postgres GiST exclusion constraint over
`(doctor_id, tstzrange(starts_at, ends_at, '[)'))`, partial on
`state IN ('HELD','CONFIRMED')`. No application locking anywhere in the booking
path. `'[)'` bounds make back-to-back slots legal; the partial index makes a
cancelled slot instantly rebookable. A second constraint stops a patient being in
two places at once.

**Slot holds** — a ten-minute `HELD` row lets the patient fill in the symptom
form safely. A hold sends no email and creates no calendar event. Expiry is
enforced both in slot computation and in the confirm `UPDATE`, so correctness
never depends on the sweeper running on time.

**Doctor leave** — two-phase. Proposing returns who would be stranded and
commits nothing. Resolving requires an explicit disposition for every conflict
and applies them in one transaction; if any replacement slot is taken, the whole
thing rolls back.

**Notification reliability** — a transactional outbox. Business state and
notification intent commit together, so a booking cannot exist without its
confirmation. A worker drains with `FOR UPDATE SKIP LOCKED`; failures retry on a
five-step ladder and then land in `DEAD`, visible in the admin console with a
one-click retry.

---

## Runs with zero credentials

| Dependency | Default | Real option |
|---|---|---|
| LLM | `mock` — deterministic offline stub | `anthropic`, `openai` |
| Email | `file` — writes `.html` to `var/mail/` | `smtp` (SendGrid, Mailgun, …) |
| Calendar | skipped silently | Google OAuth 2.0 |

Two extra modes exist purely to prove degradation: `LLM_PROVIDER=failing` and
`MAIL_TRANSPORT=failing`.

---

## Stack

Node 20 · TypeScript · NestJS · PostgreSQL 16 · Redis · BullMQ · Kysely ·
React 18 · Vite · Tailwind · Zod · Nodemailer · googleapis

### Two deviations from the original spec

**Kysely instead of Prisma.** Prisma's query and schema engines are Rust binaries
fetched from `binaries.prisma.sh` at generate time. That host was unreachable in
the environment this was built in, which meant Prisma code could be written but
never *run* — no migrations, no seed, no concurrency proof. Kysely is pure
TypeScript with the same compile-time type safety, so the entire system could be
executed and verified. The schema lives in hand-written SQL migrations, which the
exclusion constraint required anyway: no ORM DSL can express
`EXCLUDE USING gist`.

**The worker shares the API package.** It lives at `apps/api/src/worker.ts` and
runs as `npm run start:worker` — a separate process from the same build, exactly
the deployment model the design calls for, without a second package to keep in
sync.

---

## Layout

```
├── apps/
│   ├── api/                  NestJS API + worker (one build, two entry points)
│   │   ├── src/
│   │   │   ├── auth/         JWT, refresh rotation, RBAC
│   │   │   ├── scheduling/   slot math, hold/confirm/cancel, leave
│   │   │   ├── llm/          providers, breaker, prompts, summaries
│   │   │   ├── notifications/ outbox, mailer, templates
│   │   │   ├── calendar/     Google OAuth + event lifecycle
│   │   │   ├── visits/       notes, prescriptions, medication fan-out
│   │   │   ├── admin/        overview, notification console, audit
│   │   │   └── jobs/         BullMQ consumers and sweepers
│   │   └── test/             unit tests (jest)
│   └── web/                  React SPA — three portals
├── packages/
│   ├── db/                   Kysely schema, SQL migrations, seed
│   └── types/                shared DTOs and error codes
├── tests/                    integration suites (run against a live stack)
└── docs/
    ├── system-design.md      deliverable #4
    ├── api.md
    ├── db-schema.md
    ├── llm-prompts.md
    └── google-calendar-setup.md
```

## API documentation

OpenAPI is generated from the code and served at **`/api/docs`** when the API is
running. A prose walkthrough is in [`docs/api.md`](./docs/api.md).

Errors always carry a stable machine-readable `code` — `SLOT_TAKEN`,
`HOLD_EXPIRED`, `INTAKE_REQUIRED`, `LEAVE_CONFLICT`, `FORBIDDEN_RESOURCE` — never
prose the client has to pattern-match on.
