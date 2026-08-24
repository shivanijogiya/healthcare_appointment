/**
 * Failure injection.
 *
 * Boots the stack with LLM_PROVIDER=failing and MAIL_TRANSPORT=failing and
 * asserts the clinic still works: patients can book, doctors can file notes,
 * the doctor sees raw symptoms instead of an AI summary, the patient still gets
 * a complete medication plan built from prescription rows, and undeliverable
 * email lands in DEAD where an admin can see and retry it.
 *
 * Run against an API started with those env vars. See SETUP.md.
 */
const API = process.env.API_URL ?? 'http://localhost:3100';

let passed = 0, failed = 0;
const failures = [];
function check(name, cond, detail = '') {
  if (cond) { passed++; console.log(`  \x1b[32mPASS\x1b[0m ${name}`); }
  else { failed++; failures.push(name); console.log(`  \x1b[31mFAIL\x1b[0m ${name}${detail ? ` — ${detail}` : ''}`); }
}

async function api(path, { method = 'GET', token, body } = {}) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json; try { json = text ? JSON.parse(text) : null; } catch { json = text; }
  return { status: res.status, body: json };
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function nextWeekday(target = 2) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + 1);
  while (d.getUTCDay() !== target) d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

async function main() {
  console.log('\n\x1b[1mFailure injection — LLM down, SMTP down\x1b[0m\n');
  const stamp = Date.now();

  const health = await api('/health');
  check('the system reports itself healthy despite a dead LLM',
    health.body?.status === 'ok', `status=${health.body?.status}`);
  check('the LLM provider is the failing stub',
    health.body?.llm?.provider === 'failing', health.body?.llm?.provider);

  const patient = await api('/auth/register', {
    method: 'POST',
    body: { email: `fail-${stamp}@example.test`, password: 'Passw0rd!', name: 'Failure Test Patient' },
  });
  const token = patient.body?.accessToken;
  check('a patient can still register with everything down', patient.status === 201);

  const doctors = await api('/doctors', { token });
  const doctor = doctors.body[0];
  const date = nextWeekday(2);
  const grid = await api(`/doctors/${doctor.id}/slots?date=${date}`, { token });
  const free = grid.body.slots.filter((s) => s.available);
  check('slots are still computed', free.length > 0, `${free.length} free`);

  // -------------------------------------------------------------- booking ---
  console.log('\nBooking with every integration failing');
  const hold = await api('/appointments/hold', {
    method: 'POST', token, body: { doctorId: doctor.id, startsAt: free[0].startsAt },
  });
  check('a slot can still be held', hold.status === 201, `status ${hold.status}`);
  const id = hold.body?.appointmentId;

  await api(`/appointments/${id}/intake`, {
    method: 'POST', token,
    body: { symptomsText: 'Severe migraine with light sensitivity and nausea for three days.', severity: 7 },
  });
  const confirm = await api(`/appointments/${id}/confirm`, { method: 'POST', token });
  check('the appointment still confirms with the LLM offline',
    confirm.status === 200 && confirm.body.state === 'CONFIRMED',
    `${confirm.status} ${confirm.body?.state}`);

  // -------------------------------------------------------- degraded views ---
  console.log('\nDegraded, not broken');
  const doctorToken = (await api('/auth/login', {
    method: 'POST', body: { email: doctor.email, password: 'Passw0rd!' },
  })).body?.accessToken;

  let preVisit;
  for (let i = 0; i < 15; i++) {
    preVisit = await api(`/doctor/appointments/${id}/pre-visit`, { token: doctorToken });
    if (preVisit.body?.summary?.status === 'FAILED') break;
    await sleep(1000);
  }
  check('the pre-visit summary is recorded as FAILED, not left blank',
    preVisit.body?.summary?.status === 'FAILED', preVisit.body?.summary?.status);
  check('the failure reason is stored for the admin', !!preVisit.body?.summary?.errorMessage);
  check('the doctor still sees the raw symptom intake',
    preVisit.body?.intake?.symptomsText?.includes('migraine'));

  const note = await api(`/doctor/appointments/${id}/visit-note`, {
    method: 'POST', token: doctorToken,
    body: {
      clinicalNotes: 'Migraine without aura. Advised trigger diary and started abortive therapy.',
      diagnosis: 'Migraine without aura',
      prescriptions: [
        { drugName: 'Sumatriptan', dosage: '50mg', frequency: 'SOS', durationDays: 30, instructions: 'at onset' },
        { drugName: 'Naproxen', dosage: '250mg', frequency: 'BD', durationDays: 5, instructions: 'after food' },
      ],
    },
  });
  check('the doctor can still file notes and prescriptions',
    note.status === 201, `status ${note.status}`);

  let summary;
  for (let i = 0; i < 15; i++) {
    summary = await api(`/patients/me/summaries/${id}`, { token });
    if (summary.body?.status === 'FAILED') break;
    await sleep(1000);
  }
  check('the post-visit summary is marked FAILED', summary.body?.status === 'FAILED', summary.body?.status);
  check('the patient still receives a complete medication plan',
    (summary.body?.medicationSchedule ?? []).length === 2,
    `${summary.body?.medicationSchedule?.length} entries`);
  check('the summary is flagged as a prescription-derived fallback',
    summary.body?.fallback === true);

  // ------------------------------------------------------------ dead email ---
  console.log('\nUndeliverable email');
  const admin = (await api('/auth/login', {
    method: 'POST', body: { email: 'admin@clinic.test', password: 'Passw0rd!' },
  })).body.accessToken;

  // The ladder is 5 attempts with growing backoff, so within this test only the
  // first attempt has run; what matters is that it retried rather than vanished.
  await sleep(8000);
  const notifs = await api('/admin/notifications', { token: admin });
  const mine = (notifs.body ?? []).filter((n) => n.dedupe_key?.startsWith(id));
  check('notifications were still written despite SMTP being down', mine.length >= 2,
    `${mine.length} rows`);
  check('failed sends record the error and are queued for retry',
    mine.some((n) => n.attempts > 0 && !!n.last_error),
    mine.map((n) => `${n.type}:${n.state}:${n.attempts}`).join(' '));
  check('no notification was silently lost',
    mine.every((n) => ['PENDING', 'SENDING', 'DEAD', 'FAILED'].includes(n.state)));

  const overview = await api('/admin/overview', { token: admin });
  check('the admin console surfaces LLM failures',
    (overview.body?.preVisitSummaries?.FAILED ?? 0) > 0,
    JSON.stringify(overview.body?.preVisitSummaries));

  console.log(`\n\x1b[1mResult:\x1b[0m ${passed} passed, ${failed} failed`);
  if (failures.length) { console.log('\nFailures:'); failures.forEach((f) => console.log(`  - ${f}`)); }
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => { console.error('\nFailure-injection test crashed:', e); process.exit(1); });
