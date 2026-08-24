/**
 * End-to-end smoke test against a running API + worker.
 *
 * Walks the entire brief: admin creates a doctor and hours, a patient registers
 * and books, the symptom form drives a pre-visit summary, the doctor files
 * notes and a prescription, the patient gets a post-visit summary, and every
 * email lands in the outbox. Run with: node tests/e2e-smoke.mjs
 */
const API = process.env.API_URL ?? 'http://localhost:3000';

let passed = 0;
let failed = 0;
const failures = [];

function check(name, condition, detail = '') {
  if (condition) {
    passed++;
    console.log(`  \x1b[32mPASS\x1b[0m ${name}`);
  } else {
    failed++;
    failures.push(name);
    console.log(`  \x1b[31mFAIL\x1b[0m ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

async function api(path, { method = 'GET', token, body, headers = {} } = {}) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...headers,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json;
  try { json = text ? JSON.parse(text) : null; } catch { json = text; }
  return { status: res.status, body: json };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Next occurrence of a weekday (1=Mon) in clinic-local terms, as YYYY-MM-DD. */
function nextWeekday(target = 3, weeksAhead = 1) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + 1);
  while (d.getUTCDay() !== target) d.setUTCDate(d.getUTCDate() + 1);
  d.setUTCDate(d.getUTCDate() + 7 * (weeksAhead - 1));
  return d.toISOString().slice(0, 10);
}

async function main() {
  console.log(`\n\x1b[1mEnd-to-end smoke test\x1b[0m  →  ${API}\n`);

  // ---------------------------------------------------------------- health --
  console.log('Health');
  const health = await api('/health');
  check('GET /health responds 200', health.status === 200, `got ${health.status}`);
  check('database is up', health.body?.database === 'up', health.body?.database);
  check('redis is up', health.body?.redis === 'up', health.body?.redis);

  // ------------------------------------------------------------------ auth --
  console.log('\nAuthentication and RBAC');
  const admin = await api('/auth/login', {
    method: 'POST',
    body: { email: 'admin@clinic.test', password: 'Passw0rd!' },
  });
  check('admin can sign in', admin.status === 200 && !!admin.body.accessToken, `status ${admin.status}`);
  const adminToken = admin.body?.accessToken;

  const badLogin = await api('/auth/login', {
    method: 'POST',
    body: { email: 'admin@clinic.test', password: 'wrong-password' },
  });
  check('wrong password is rejected with INVALID_CREDENTIALS',
    badLogin.status === 401 && badLogin.body?.code === 'INVALID_CREDENTIALS',
    `${badLogin.status} ${badLogin.body?.code}`);

  const noAuth = await api('/admin/overview');
  check('unauthenticated admin route returns 401', noAuth.status === 401, `got ${noAuth.status}`);

  // Register a fresh patient so repeat runs do not collide.
  const patientEmail = `smoke-${Date.now()}@example.test`;
  const reg = await api('/auth/register', {
    method: 'POST',
    body: { email: patientEmail, password: 'Passw0rd!', name: 'Smoke Patient', dateOfBirth: '1990-05-04', gender: 'Female' },
  });
  check('patient can self-register', reg.status === 201 && !!reg.body.accessToken, `status ${reg.status}`);
  const patientToken = reg.body?.accessToken;

  const escalation = await api('/admin/overview', { token: patientToken });
  check('patient is refused an admin route (FORBIDDEN_RESOURCE)',
    escalation.status === 403 && escalation.body?.code === 'FORBIDDEN_RESOURCE',
    `${escalation.status} ${escalation.body?.code}`);

  const refreshed = await api('/auth/refresh', {
    method: 'POST',
    body: { refreshToken: reg.body.refreshToken },
  });
  check('refresh token rotates into a new access token',
    refreshed.status === 200 && !!refreshed.body.accessToken);
  const replay = await api('/auth/refresh', {
    method: 'POST',
    body: { refreshToken: reg.body.refreshToken },
  });
  check('a used refresh token cannot be replayed', replay.status === 401, `got ${replay.status}`);

  // --------------------------------------------------------------- doctors --
  console.log('\nDoctors and availability');
  const doctors = await api('/doctors', { token: patientToken });
  check('doctor search returns the seeded clinic', doctors.status === 200 && doctors.body.length >= 3,
    `${doctors.body?.length} doctors`);

  const specs = await api('/doctors/specialisations', { token: patientToken });
  check('specialisations are listed for the filter', specs.status === 200 && specs.body.length >= 3);

  const cardio = (doctors.body ?? []).find((d) => d.specialisation === 'Cardiology');
  check('can filter to a specialisation', !!cardio);

  const filtered = await api('/doctors?specialisation=Cardiology', { token: patientToken });
  check('specialisation filter narrows results',
    filtered.status === 200 && filtered.body.every((d) => d.specialisation === 'Cardiology'));

  // ----------------------------------------------------------------- slots --
  console.log('\nSlot computation');
  const date = nextWeekday(3); // a Wednesday, when every seeded doctor works
  const grid = await api(`/doctors/${cardio.id}/slots?date=${date}`, { token: patientToken });
  check('slot grid is computed for a working day', grid.status === 200 && grid.body.slots.length > 0,
    `${grid.body?.slots?.length} slots on ${date}`);
  check('slot length matches the doctor’s configured duration',
    grid.body?.slotDurationMin === 30, `${grid.body?.slotDurationMin} min`);

  const free = (grid.body?.slots ?? []).filter((s) => s.available);
  check('at least two free slots exist to book against', free.length >= 2, `${free.length} free`);

  const sunday = await api(`/doctors/${cardio.id}/slots?date=${nextWeekday(0)}`, { token: patientToken });
  check('a non-working day yields no slots', sunday.status === 200 && sunday.body.slots.length === 0,
    `${sunday.body?.slots?.length} slots`);

  // ------------------------------------------------------------ hold/confirm
  console.log('\nBooking lifecycle');
  const slot = free[0];
  const hold = await api('/appointments/hold', {
    method: 'POST', token: patientToken,
    body: { doctorId: cardio.id, startsAt: slot.startsAt },
  });
  check('a slot can be held', hold.status === 201 && !!hold.body.appointmentId, `status ${hold.status}`);
  const appointmentId = hold.body?.appointmentId;
  check('the hold carries an expiry', !!hold.body?.holdExpiresAt);

  const holdAgain = await api('/appointments/hold', {
    method: 'POST', token: patientToken,
    body: { doctorId: cardio.id, startsAt: slot.startsAt },
  });
  check('holding the same slot again is refused with SLOT_TAKEN',
    holdAgain.status === 409 && holdAgain.body?.code === 'SLOT_TAKEN',
    `${holdAgain.status} ${holdAgain.body?.code}`);

  const gridAfterHold = await api(`/doctors/${cardio.id}/slots?date=${date}`, { token: patientToken });
  const heldSlot = gridAfterHold.body.slots.find((s) => s.startsAt === slot.startsAt);
  check('a held slot disappears from availability', heldSlot && !heldSlot.available && heldSlot.reason === 'BOOKED');

  const earlyConfirm = await api(`/appointments/${appointmentId}/confirm`, {
    method: 'POST', token: patientToken,
  });
  check('confirming without the symptom form is refused (INTAKE_REQUIRED)',
    earlyConfirm.status === 422 && earlyConfirm.body?.code === 'INTAKE_REQUIRED',
    `${earlyConfirm.status} ${earlyConfirm.body?.code}`);

  const intake = await api(`/appointments/${appointmentId}/intake`, {
    method: 'POST', token: patientToken,
    body: {
      symptomsText: 'Crushing chest pain radiating to the left arm for two days, worse on exertion, with breathlessness.',
      durationDays: 2, severity: 8, existingMeds: 'Amlodipine 5mg', allergies: 'Penicillin',
    },
  });
  check('symptom form is accepted', intake.status === 200, `status ${intake.status}`);

  const confirm = await api(`/appointments/${appointmentId}/confirm`, {
    method: 'POST', token: patientToken,
  });
  check('appointment confirms after intake', confirm.status === 200 && confirm.body.state === 'CONFIRMED',
    `${confirm.status} ${confirm.body?.state}`);

  const idem = `smoke-${Date.now()}`;
  const a = await api('/appointments/hold', {
    method: 'POST', token: patientToken, headers: { 'idempotency-key': idem },
    body: { doctorId: cardio.id, startsAt: free[1].startsAt },
  });
  const b = await api('/appointments/hold', {
    method: 'POST', token: patientToken, headers: { 'idempotency-key': idem },
    body: { doctorId: cardio.id, startsAt: free[1].startsAt },
  });
  check('a retried hold with the same Idempotency-Key returns the original',
    a.body?.appointmentId && a.body.appointmentId === b.body?.appointmentId);

  // ----------------------------------------------------------- notifications
  console.log('\nNotifications');
  await sleep(6000); // let the outbox drain tick
  const notifications = await api('/admin/notifications', { token: adminToken });
  const forAppt = (notifications.body ?? []).filter((n) => n.dedupe_key?.startsWith(appointmentId));
  check('confirmation emails were written to the outbox', forAppt.length >= 2,
    `${forAppt.length} rows`);
  check('a 24h reminder was scheduled at confirm time',
    forAppt.some((n) => n.type === 'REMINDER_24H'));
  check('confirmation emails were actually sent',
    forAppt.filter((n) => n.type.startsWith('BOOKING_CONFIRMED')).every((n) => n.state === 'SENT'),
    forAppt.map((n) => `${n.type}:${n.state}`).join(' '));

  // ------------------------------------------------------- pre-visit summary
  console.log('\nAI pre-visit summary');
  const doctorLogin = await api('/auth/login', {
    method: 'POST', body: { email: 'dr.rao@clinic.test', password: 'Passw0rd!' },
  });
  const doctorToken = doctorLogin.body?.accessToken;
  check('doctor can sign in', doctorLogin.status === 200 && !!doctorToken);

  let preVisit;
  for (let i = 0; i < 12; i++) {
    preVisit = await api(`/doctor/appointments/${appointmentId}/pre-visit`, { token: doctorToken });
    if (preVisit.body?.summary?.status && preVisit.body.summary.status !== 'PENDING') break;
    await sleep(1000);
  }
  check('pre-visit summary reached a terminal state',
    ['SUCCESS', 'FAILED', 'SKIPPED'].includes(preVisit.body?.summary?.status),
    preVisit.body?.summary?.status);
  check('the raw intake is always available to the doctor',
    !!preVisit.body?.intake?.symptomsText);

  if (preVisit.body?.summary?.status === 'SUCCESS') {
    check('summary carries a valid urgency level',
      ['LOW', 'MEDIUM', 'HIGH'].includes(preVisit.body.summary.urgency),
      preVisit.body.summary.urgency);
    check('summary suggests exactly three questions',
      preVisit.body.summary.questions?.length === 3,
      `${preVisit.body.summary.questions?.length}`);
    check('summary records a chief complaint', !!preVisit.body.summary.chiefComplaint);
    check('prompt version is stored for traceability',
      preVisit.body.summary.promptVersion === 'v1');
  }

  const otherDoctor = await api('/auth/login', {
    method: 'POST', body: { email: 'dr.mehta@clinic.test', password: 'Passw0rd!' },
  });
  const peek = await api(`/doctor/appointments/${appointmentId}/pre-visit`, {
    token: otherDoctor.body?.accessToken,
  });
  check('another doctor cannot read this appointment (ownership check)',
    peek.status === 403, `got ${peek.status}`);

  // ------------------------------------------------------ visit + follow-up --
  console.log('\nVisit notes, prescriptions and post-visit summary');
  const note = await api(`/doctor/appointments/${appointmentId}/visit-note`, {
    method: 'POST', token: doctorToken,
    body: {
      clinicalNotes: 'Stable angina suspected. ECG unremarkable at rest. Starting antianginal therapy and arranging a stress test.',
      diagnosis: 'Stable angina pectoris',
      followUpDate: nextWeekday(3, 3),
      prescriptions: [
        { drugName: 'Aspirin', dosage: '75mg', frequency: 'OD', durationDays: 30, instructions: 'after food' },
        { drugName: 'Metoprolol', dosage: '25mg', frequency: 'BD', durationDays: 30 },
      ],
    },
  });
  check('doctor can file visit notes with prescriptions',
    note.status === 201 && !!note.body.visitNoteId, `status ${note.status}`);
  check('appointment is marked COMPLETED', note.body?.state === 'COMPLETED');

  const duplicate = await api(`/doctor/appointments/${appointmentId}/visit-note`, {
    method: 'POST', token: doctorToken,
    body: { clinicalNotes: 'Duplicate submission attempt for the same visit.' },
  });
  check('notes cannot be filed twice for one visit', duplicate.status === 409, `got ${duplicate.status}`);

  let summary;
  for (let i = 0; i < 12; i++) {
    summary = await api(`/patients/me/summaries/${appointmentId}`, { token: patientToken });
    if (summary.body?.status && summary.body.status !== 'PENDING') break;
    await sleep(1000);
  }
  check('patient can read a post-visit summary',
    summary.status === 200 && !!summary.body, `status ${summary.status}`);
  check('the medication plan is present either way',
    (summary.body?.medicationSchedule ?? []).length >= 2,
    `${summary.body?.medicationSchedule?.length} entries, fallback=${summary.body?.fallback}`);

  await sleep(3000);
  const afterVisit = await api('/admin/notifications', { token: adminToken });
  check('a post-visit summary email was queued',
    (afterVisit.body ?? []).some((n) => n.type === 'POST_VISIT_SUMMARY'));

  // ------------------------------------------------------------ cancellation
  console.log('\nCancellation');
  const toCancel = await api('/appointments/hold', {
    method: 'POST', token: patientToken,
    body: { doctorId: cardio.id, startsAt: free[2].startsAt },
  });
  await api(`/appointments/${toCancel.body.appointmentId}/intake`, {
    method: 'POST', token: patientToken,
    body: { symptomsText: 'Routine follow-up review for blood pressure monitoring.' },
  });
  await api(`/appointments/${toCancel.body.appointmentId}/confirm`, { method: 'POST', token: patientToken });
  const cancelled = await api(`/appointments/${toCancel.body.appointmentId}/cancel`, {
    method: 'POST', token: patientToken, body: { reason: 'Travelling that week' },
  });
  check('a confirmed appointment can be cancelled',
    cancelled.status === 200 && cancelled.body.state === 'CANCELLED', `status ${cancelled.status}`);

  const gridAfterCancel = await api(`/doctors/${cardio.id}/slots?date=${date}`, { token: patientToken });
  const freed = gridAfterCancel.body.slots.find((s) => s.startsAt === free[2].startsAt);
  check('cancelling releases the slot for rebooking', freed?.available === true);

  await sleep(6000);
  const cancelNotifs = await api('/admin/notifications', { token: adminToken });
  check('cancellation emails were queued for both parties',
    (cancelNotifs.body ?? []).filter(
      (n) => n.dedupe_key?.startsWith(toCancel.body.appointmentId) && n.type.startsWith('CANCELLED'),
    ).length === 2);
  check('the pending reminder for a cancelled appointment was killed',
    (cancelNotifs.body ?? []).some(
      (n) => n.dedupe_key === `${toCancel.body.appointmentId}:REMINDER_24H` && n.state === 'DEAD',
    ));

  // ------------------------------------------------------------------ admin --
  console.log('\nAdmin console');
  const overview = await api('/admin/overview', { token: adminToken });
  check('overview aggregates clinic state', overview.status === 200 && overview.body.doctors >= 3);
  const audit = await api('/admin/audit', { token: adminToken });
  check('audit trail records actions', audit.status === 200 && audit.body.length > 0,
    `${audit.body?.length} entries`);

  // ----------------------------------------------------------------- result --
  console.log(`\n\x1b[1mResult:\x1b[0m ${passed} passed, ${failed} failed`);
  if (failures.length) {
    console.log('\nFailures:');
    for (const f of failures) console.log(`  - ${f}`);
  }
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error('\nSmoke test crashed:', e);
  process.exit(1);
});
