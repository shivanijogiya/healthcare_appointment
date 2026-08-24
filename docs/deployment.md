# Deployment guide

Free hosting: API + Worker + Postgres + Redis on **Render**, frontend on **Vercel**.
Total cost: $0. Takes about 15 minutes.

---

## Prerequisites

- Push the project to a **GitHub repo** (public or private).
- Accounts on [render.com](https://render.com) and [vercel.com](https://vercel.com) — both free with GitHub login.

```bash
# In your project root
git init
git add .
git commit -m "initial"
git remote add origin https://github.com/YOUR_USERNAME/YOUR_REPO.git
git push -u origin main
```

---

## Step 1 — Deploy the backend on Render

### 1a. Create a Postgres database

Render dashboard → **New → PostgreSQL**

| Field | Value |
|---|---|
| Name | `ham-postgres` |
| Database | `ham` |
| User | `ham` |
| Region | Oregon (or closest) |
| Plan | **Free** |

Click **Create Database**. Wait until status is **Available**, then copy the **Internal Database URL** — you'll need it in 1c.

### 1b. Create a Redis instance

Render dashboard → **New → Redis**

| Field | Value |
|---|---|
| Name | `ham-redis` |
| Region | Same as Postgres |
| Plan | **Free** |

Click **Create**. Copy the **Internal Redis URL**.

### 1c. Deploy the API

Render dashboard → **New → Web Service** → Connect your GitHub repo.

| Field | Value |
|---|---|
| Name | `ham-api` |
| Region | Same as databases |
| Branch | `main` |
| Runtime | **Node** |
| Build Command | `npm install && npm run build:packages && cd apps/api && npx nest build` |
| Start Command | `node apps/api/dist/main.js` |
| Plan | **Free** |

Then add these **Environment Variables**:

| Key | Value |
|---|---|
| `NODE_ENV` | `production` |
| `PORT` | `10000` |
| `DATABASE_URL` | Internal URL from step 1a |
| `REDIS_URL` | Internal URL from step 1b |
| `JWT_SECRET` | Click **Generate** |
| `JWT_REFRESH_SECRET` | Click **Generate** |
| `ENCRYPTION_KEY` | Run `openssl rand -hex 32` locally and paste |
| `CLINIC_TIMEZONE_OFFSET_MINUTES` | `330` |
| `LLM_PROVIDER` | `mock` (or `anthropic` with your key) |
| `LLM_API_KEY` | Your Anthropic/OpenAI key (leave blank for mock) |
| `LLM_MODEL` | `claude-sonnet-4-5` |
| `MAIL_TRANSPORT` | `file` (emails written to disk; set `smtp` for real delivery) |
| `APP_URL` | Leave blank for now — fill in after Vercel deploy |

Set the **Health Check Path** to `/health`.

Click **Create Web Service**. Render will build and deploy — takes 3–5 minutes.

Once deployed, copy your API URL, e.g. `https://ham-api.onrender.com`.

### 1d. Run migrations + seed

In Render dashboard → **ham-api → Shell**:

```bash
npm run migrate
npm run seed
```

Or set the **Pre-Deploy Command** to `npm run migrate && npm run seed` under Settings → Deploy.

### 1e. Deploy the Worker

Render dashboard → **New → Background Worker** → same GitHub repo.

| Field | Value |
|---|---|
| Name | `ham-worker` |
| Build Command | `npm install && npm run build:packages && cd apps/api && npx nest build` |
| Start Command | `node apps/api/dist/worker.js` |
| Plan | **Free** |

Add the **same environment variables** as the API (copy them). The worker shares the same DB, Redis and secrets.

---

## Step 2 — Deploy the frontend on Vercel

Vercel dashboard → **Add New → Project** → import your GitHub repo.

| Field | Value |
|---|---|
| Framework Preset | **Other** |
| Root Directory | `.` (repo root) |
| Build Command | `npm run build:packages && cd apps/web && npm run build` |
| Output Directory | `apps/web/dist` |
| Install Command | `npm install` |

Add these **Environment Variables**:

| Key | Value |
|---|---|
| `VITE_API_URL` | `https://ham-api.onrender.com` (your Render API URL) |
| `VITE_CLINIC_OFFSET_MINUTES` | `330` |

Click **Deploy**. Vercel gives you a URL like `https://ham-web.vercel.app`.

---

## Step 3 — Wire them together

### Update CORS on the API

Go back to Render → **ham-api → Environment** → add/update:

| Key | Value |
|---|---|
| `APP_URL` | `https://ham-web.vercel.app` |

Click **Save Changes** — Render redeploys automatically.

### Update Google Calendar redirect (if using it)

In Google Cloud Console, add `https://ham-api.onrender.com/calendar/callback` as an authorised redirect URI.

Update in Render environment:

| Key | Value |
|---|---|
| `GOOGLE_CLIENT_ID` | Your client ID |
| `GOOGLE_CLIENT_SECRET` | Your client secret |
| `GOOGLE_REDIRECT_URI` | `https://ham-api.onrender.com/calendar/callback` |

---

## Step 4 — Verify

Visit your Vercel URL. Sign in with `priya@example.test` / `Passw0rd!`.

Check the API health endpoint directly:

```
https://ham-api.onrender.com/health
```

Should return `"status": "ok"` with database and redis both `"up"`.

OpenAPI docs (useful for the examiner):

```
https://ham-api.onrender.com/api/docs
```

---

## Render free tier notes

- **Free services spin down after 15 minutes of inactivity** and take ~30 seconds to wake on the next request. The first sign-in after a period of inactivity may feel slow — this is Render's free tier, not the application.
- **Postgres and Redis on free tier** are available for 90 days. For a long-lived deployment upgrade to the paid tier.
- The **worker** on free tier also spins down. Reminder emails and LLM summaries may be delayed until it wakes. Everything is still delivered correctly once it's running.

---

## Deliverables checklist

After completing the above:

| Deliverable | Where |
|---|---|
| 1. Source code zip | Downloaded from Claude |
| 2. README + docs | `README.md`, `SETUP.md`, `docs/` |
| 3. Hosted URL | `https://your-name.vercel.app` |
| 4. System design | `docs/system-design.md` |
