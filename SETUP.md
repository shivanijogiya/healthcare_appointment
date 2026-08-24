# Setup

Getting from a fresh clone to a working clinic takes about three minutes.

## Requirements

- **Node 20 or newer** (`node -v`)
- **Docker** — for Postgres and Redis. If you already run both locally, skip
  step 2 and point `DATABASE_URL` / `REDIS_URL` at them instead.

No API keys are needed. The LLM and email default to offline modes so the entire
system works end to end with nothing to sign up for.

---

## 1. Install

```bash
npm install
```

This installs every workspace (`apps/api`, `apps/web`, `packages/db`,
`packages/types`) and then builds the two shared packages, because the API and
web app import `@ham/db` and `@ham/types` as compiled modules. If you ever see
`Cannot find module '@ham/types'`, that build was skipped — run it directly:

```bash
npm run build:packages
```

`npm run dev`, `npm run build` and `npm test` all do this for you first.

## 2. Start Postgres and Redis

```bash
docker compose up -d
```

Wait a few seconds for both to report healthy:

```bash
docker compose ps
```

## 3. Configure

```bash
cp .env.example .env
```

The defaults work as-is against the docker-compose services. Every variable is
documented inline in the file.

## 4. Create the schema and demo data

```bash
npm run migrate
npm run seed
```

`migrate` applies the SQL migrations in order, including the `btree_gist`
extension and the exclusion constraint that prevents double booking. `seed`
creates a demo clinic.

## 5. Run it

```bash
npm run dev
```

That starts three processes together:

| Process | URL |
|---|---|
| API | http://localhost:3000 |
| API docs (OpenAPI) | http://localhost:3000/api/docs |
| Web app | http://localhost:5173 |
| Worker | background — no port |

The API and worker each type-check on start, so the first launch takes roughly a
minute before `API on :3000` appears. Until then the web app cannot reach the
API and sign-in shows **Request failed** — wait for that line in the console
rather than assuming something is broken.

Open **http://localhost:5173** and sign in.

---

## Demo accounts

Password for all of them: **`Passw0rd!`**

| Email | Role | Notes |
|---|---|---|
| `admin@clinic.test` | Admin | Doctor profiles, notification console, audit |
| `dr.rao@clinic.test` | Doctor | Cardiology, 30-minute slots |
| `dr.mehta@clinic.test` | Doctor | General Medicine, 15-minute slots |
| `dr.fernandes@clinic.test` | Doctor | Dermatology, 20-minute slots |
| `priya@example.test` | Patient | |
| `arjun@example.test` | Patient | |

New patients can also self-register from the sign-in screen.

---

## A five-minute tour

1. Sign in as **priya@example.test**. Pick a specialisation, choose a doctor,
   pick a date from the strip. Unavailable slots are shown greyed out with the
   reason rather than hidden.
2. Click a time. You now hold it for ten minutes — there is a live countdown.
   Fill in the symptom form and confirm.
3. Open `var/mail/` — the confirmation emails for both you and the doctor are
   sitting there as `.html` files. Open one in a browser.
4. Sign in as **dr.rao@clinic.test**, open your schedule, click the appointment.
   The AI pre-visit summary appears with an urgency level, a chief complaint and
   three suggested questions. The patient's own words are always shown
   underneath.
5. File notes with a prescription or two. Set the frequency — that drives the
   medication reminder schedule.
6. Back as the patient, open **Visit summary**: a plain-language summary and the
   medication plan.
7. Sign in as **admin@clinic.test** to see the notification console, including
   anything that failed and a retry button.

To watch leave handling, sign in as a doctor, go to **Time off**, and request a
range covering a booked appointment. You will be shown exactly who it affects
before anything is sent.

---

## Tests

The unit tests run standalone. The integration suites run against a live stack,
so start `npm run dev` in another terminal first.

```bash
npm run test              # unit tests — 48, no services needed
npm run test:e2e          # full clinical flow — 49 assertions
npm run test:leave        # doctor leave, two-phase — 23 assertions
npm run test:concurrency  # 50 simultaneous holds on one slot
npm run test:all          # everything above
```

### The concurrency proof

```bash
npm run test:concurrency
```

```
Results
  201 Created            1
  409 SLOT_TAKEN         49
  unexpected responses   0
  live rows in database  1
  elapsed                334ms
```

It registers 50 distinct patients and fires 50 simultaneous hold requests at one
slot. Distinct patients matter: identical ones would also collide on the
patient-overlap constraint, which would prove the wrong thing.

### Failure injection

This one needs the stack running in failure mode, so it takes two terminals:

```bash
# terminal 1
PORT=3100 LLM_PROVIDER=failing MAIL_TRANSPORT=failing npm run start:api
PORT=3100 LLM_PROVIDER=failing MAIL_TRANSPORT=failing npm run start:worker

# terminal 2
npm run test:failure
```

With both the model and SMTP dead: booking still confirms, the doctor sees the
raw symptom intake, the patient still receives a complete medication plan built
from prescription rows, and no notification is silently lost.

---

## Optional: a real LLM

```bash
LLM_PROVIDER=anthropic
LLM_API_KEY=sk-ant-...
LLM_MODEL=claude-sonnet-4-5
```

`openai` works the same way. If the key is missing the system logs a warning and
falls back to the mock rather than failing to start.

## Optional: real email

```bash
MAIL_TRANSPORT=smtp
SMTP_HOST=smtp.sendgrid.net
SMTP_PORT=587
SMTP_USER=apikey
SMTP_PASS=SG...
MAIL_FROM="Meridian Clinic <noreply@yourdomain.com>"
```

## Optional: Google Calendar

See [`docs/google-calendar-setup.md`](./docs/google-calendar-setup.md). Without
it, calendar steps are skipped silently — connecting is a feature, never a
prerequisite for booking.

---

## Production build

```bash
npm run build

npm run start:api      # or: node apps/api/dist/main.js
npm run start:worker   # or: node apps/api/dist/worker.js
```

The web app builds to `apps/web/dist` as static files. When serving that build
rather than the dev server, set `VITE_API_URL` at build time — the dev proxy that
forwards `/api` only exists in `vite dev`:

```bash
VITE_API_URL=https://your-api.example.com npm run build -w @ham/web
```

### Deploying

| Component | Service | Command |
|---|---|---|
| API | Render Web Service | `npm run start:api`, health check `/health` |
| Worker | Render Background Worker | `npm run start:worker` (same build) |
| Postgres | Render / Neon | run `npm run migrate` once on first deploy |
| Redis | Upstash / Render | |
| Web | Vercel | build with `VITE_API_URL` set |

Register the Google OAuth redirect URI for both `localhost` and the production
domain.

---

## Troubleshooting

**`DATABASE_URL is not set`** — you skipped `cp .env.example .env`.

**`btree_gist` errors during migration** — the Postgres user needs permission to
create extensions. The docker-compose superuser has it; a managed database may
need `CREATE EXTENSION btree_gist;` run once by an admin.

**Emails aren't arriving** — with the default `MAIL_TRANSPORT=file` they are
never sent. Look in `var/mail/`.

**Summaries stay `PENDING`** — the worker isn't running. Start it with
`npm run dev:worker` and check `/health/queues`.

**Everything is `degraded` at `/health`** — Postgres or Redis is down. Note that
a failing LLM deliberately does *not* make the system unhealthy: booking,
cancellation and note submission all work without it.

**Port already in use** — set `PORT` for the API; pass `--port` to Vite.

**`Cannot find module '@ham/types'` or `'@ham/db'`** — the shared packages have
not been compiled. Run `npm run build:packages`.

**Sign-in says "Request failed" and the console shows `http proxy error:
/auth/login  ECONNREFUSED`** — the API is not listening yet. Either it is still
type-checking on first start (give it a minute), or it failed to compile; scroll
up in the `[api]` output for the real error.
