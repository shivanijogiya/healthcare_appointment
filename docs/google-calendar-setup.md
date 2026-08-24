# Google Calendar setup

Entirely optional. With `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` unset,
every calendar step becomes a silent no-op and the clinic works normally.
Connecting a calendar is a feature, never a prerequisite for booking.

## 1. Create a project

1. Open the [Google Cloud Console](https://console.cloud.google.com/).
2. Create a project, or pick an existing one.
3. **APIs & Services → Library** → enable the **Google Calendar API**.

## 2. Configure the consent screen

**APIs & Services → OAuth consent screen**

- User type **External** (unless everyone is in one Workspace domain).
- Fill in the app name, support email and developer contact.
- Add the scope **`https://www.googleapis.com/auth/calendar.events`** — this
  grants event access only, not the ability to read the rest of someone's
  calendar.
- While the app is in **Testing**, add each doctor and patient who will connect
  as a test user. Unlisted accounts are refused.

## 3. Create credentials

**APIs & Services → Credentials → Create credentials → OAuth client ID**

- Application type: **Web application**
- Authorised redirect URIs — add both:

```
http://localhost:3000/calendar/callback
https://your-api-domain.com/calendar/callback
```

The URI must match `GOOGLE_REDIRECT_URI` exactly, trailing slash included.

## 4. Configure the app

```bash
GOOGLE_CLIENT_ID=1234567890-abc.apps.googleusercontent.com
GOOGLE_CLIENT_SECRET=GOCSPX-…
GOOGLE_REDIRECT_URI=http://localhost:3000/calendar/callback

# 32 bytes of hex — encrypts stored refresh tokens.
# openssl rand -hex 32
ENCRYPTION_KEY=…
```

Restart the API and worker.

## 5. Connect

Sign in as a doctor or patient and use **Connect Google Calendar** in the header.
`/health` will show `calendar.configured: true`; `/calendar/status` reports
whether the signed-in user has connected.

## How it works

The consent URL is generated with `access_type=offline` and `prompt=consent`.
The explicit prompt matters: without it Google returns a refresh token only on
the very first authorisation and silently omits it afterwards, which breaks
reconnection in a way that is painful to debug.

Refresh tokens are encrypted with AES-256-GCM before being stored — a refresh
token is a long-lived key to someone's diary. Access tokens are never persisted;
they are refreshed on demand and held in memory for the duration of a call.

| Event | Calendar action |
|---|---|
| Appointment confirmed | `events.insert` on both calendars; ids stored per side |
| Rescheduled | `events.patch`, so the invite thread survives |
| Cancelled | `events.delete`; a 404 counts as success — already gone is the goal |
| Leave-driven rebook | patch rather than delete-and-insert |

Every write goes through the queue with retry. A calendar failure is logged and
retried and **never** rolls back an appointment. A reconciliation job runs every
15 minutes and repairs drift: a confirmed appointment missing its event gets one,
and a cancelled appointment still holding an event id has it removed. That covers
the case where a write failed permanently after exhausting retries.

Each party is independent — a patient with no Google account does not stop the
doctor's event being written.

## Troubleshooting

**`redirect_uri_mismatch`** — the registered URI and `GOOGLE_REDIRECT_URI` differ.
They must match character for character.

**"Google did not return a refresh token"** — the account previously authorised
the app. Revoke it at
[myaccount.google.com/permissions](https://myaccount.google.com/permissions) and
connect again.

**`access_denied`** — the account is not on the test-user list while the consent
screen is in Testing.

**Events are not appearing** — check `/health/queues` for a backlog and confirm
the worker is running; calendar writes happen there, not in the API.
