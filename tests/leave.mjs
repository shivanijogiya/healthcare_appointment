/**
 * Doctor leave with existing bookings.
 *
 * Proves the two-phase contract: proposing leave reports who it would strand
 * without touching them, and resolving it applies every disposition atomically —
 * including rolling the whole thing back when a replacement slot is already
 * taken.
 *
 * Run with: node tests/leave.mjs
 */
const API = process.env.API_URL ?? 'http://localhost:3000';

let passed = 0, failed = 0;
const failures = [];
function check(name, cond, detail = '') {
  if (cond) { passed++; console.log(`  \x1b[32mPASS\x1b[0m ${name}`); }
  else { failed++; failures.push(name); console.log(`  \x1b[31mFAIL\x1b[0m ${name}${detail ? ` — ${detail}` : ''}`); }
}

async function api(path, { method = 'GET', token, body, headers = {} } = {}) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json; try { json = text ? JSON.parse(text) : null; } catch { json = text; }
  return { status: res.status, body: json };
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function nextWeekday(target = 4) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + 1);
  while (d.getUTCDay() !== target) d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

/** Books and confirms an appointment, returning its id. */
async function book(token, doctorId, startsAt) {
  const hold = await api('/appointments/hold', {
    method: 'POST', token, body: { doctorId, startsAt },
  });
  if (hold.status !== 201) throw new Error(`hold failed: ${hold.status} ${JSON.stringify(hold.body)}`);
  await api(`/appointments/${hold.body.appointmentId}/intake`, {
    method: 'POST', token,
    body: { symptomsText: 'Persistent dry cough with mild fever for the last four days.' },
  });
  const c = await api(`/appointments/${hold.body.appointmentId}/confirm`, { method: 'POST', token });
  if (c.status !== 200) throw new Error(`confirm failed: ${c.status}`);
  return hold.body.appointmentId;
}

async function main() {
  console.log('\n\x1b[1mDoctor leave with existing bookings\x1b[0m\n');
  const stamp = Date.now();

  const admin = (await api('/auth/login', {
    method: 'POST', body: { email: 'admin@clinic.test', password: 'Passw0rd!' },
  })).body.accessToken;

  // A dedicated doctor keeps this test independent of the others.
  const doctor = await api('/doctors', {
    method: 'POST', token: admin,
    body: {
      email: `leave-doc-${stamp}@clinic.test`, password: 'Passw0rd!',
      name: `Dr. Leave Test ${stamp}`, specialisation: `LeaveTest${stamp}`, slotDurationMin: 30,
    },
  });
  check('admin can create a doctor', doctor.status === 201, `status ${doctor.status}`);
  const doctorId = doctor.body.id;

  const avail = await api(`/doctors/${doctorId}/availability`, {
    method: 'PUT', token: admin,
    body: { windows: [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({ weekday, startTime: '09:00', endTime: '13:00' })) },
  });
  check('admin can set working hours', avail.status === 200, `status ${avail.status}`);

  const patients = await Promise.all([0, 1, 2].map(async (i) => {
    const r = await api('/auth/register', {
      method: 'POST',
      body: { email: `leave-p-${stamp}-${i}@example.test`, password: 'Passw0rd!', name: `Leave Patient ${i}` },
    });
    return r.body.accessToken;
  }));

  const date = nextWeekday(4);
  const grid = await api(`/doctors/${doctorId}/slots?date=${date}`, { token: patients[0] });
  const free = grid.body.slots.filter((s) => s.available);
  check('the new doctor has bookable slots', free.length >= 4, `${free.length} free on ${date}`);

  const booked = [];
  for (let i = 0; i < 3; i++) booked.push(await book(patients[i], doctorId, free[i].startsAt));
  check('three patients booked with this doctor', booked.length === 3);

  // ------------------------------------------------------------- phase 1 ----
  console.log('\nPhase 1 — propose');
  const dayStart = new Date(free[0].startsAt);
  const dayEnd = new Date(new Date(free[free.length - 1].endsAt).getTime());

  const proposal = await api(`/doctors/${doctorId}/leave`, {
    method: 'POST', token: admin,
    body: { startsAt: dayStart.toISOString(), endsAt: dayEnd.toISOString(), reason: 'Conference' },
  });
  check('leave can be proposed', proposal.status === 201 && !!proposal.body.leaveId, `status ${proposal.status}`);
  check('proposal reports every affected appointment',
    proposal.body?.conflicts?.length === 3, `${proposal.body?.conflicts?.length} conflicts`);
  check('proposal stays PROPOSED until resolved', proposal.body?.status === 'PROPOSED');
  check('proposal suggests replacement slots', Object.keys(proposal.body?.suggestions ?? {}).length === 3);

  const stillConfirmed = await api(`/appointments/${booked[0]}`, { token: patients[0] });
  check('proposing leave does not touch the bookings yet',
    stillConfirmed.body?.state === 'CONFIRMED', stillConfirmed.body?.state);

  const notifsBefore = await api('/admin/notifications', { token: admin });
  check('no patient is emailed during phase 1',
    !(notifsBefore.body ?? []).some((n) => n.type === 'LEAVE_RESCHEDULED' && n.dedupe_key.includes(proposal.body.leaveId)));

  // --------------------------------------------- rollback on a taken slot ---
  console.log('\nAll-or-nothing rollback');
  const laterDate = nextWeekday(4);
  const nextDay = new Date(new Date(laterDate).getTime() + 7 * 86400000).toISOString().slice(0, 10);
  const laterGrid = await api(`/doctors/${doctorId}/slots?date=${nextDay}`, { token: patients[0] });
  const laterFree = laterGrid.body.slots.filter((s) => s.available);

  // Occupy one target slot so the resolve below must fail.
  const blocker = await book(patients[0], doctorId, laterFree[0].startsAt);
  check('a replacement slot was deliberately occupied', !!blocker);

  const doomed = await api(`/doctors/${doctorId}/leave/${proposal.body.leaveId}/resolve`, {
    method: 'POST', token: admin,
    body: {
      dispositions: [
        { appointmentId: booked[0], action: 'REBOOK_SAME_DOCTOR', newStartsAt: laterFree[1].startsAt },
        { appointmentId: booked[1], action: 'REBOOK_SAME_DOCTOR', newStartsAt: laterFree[0].startsAt }, // taken
        { appointmentId: booked[2], action: 'CANCEL' },
      ],
    },
  });
  check('a conflicting replacement is refused with LEAVE_CONFLICT',
    doomed.status === 409 && doomed.body?.code === 'LEAVE_CONFLICT',
    `${doomed.status} ${doomed.body?.code}`);

  const untouched = await api(`/appointments/${booked[2]}`, { token: patients[2] });
  check('nothing was applied — the CANCEL disposition did not take effect',
    untouched.body?.state === 'CONFIRMED', untouched.body?.state);
  const leaveStatus = await api(`/doctors/${doctorId}/leave`, { token: admin });
  check('the leave itself is still PROPOSED after a failed resolve',
    leaveStatus.body.find((l) => l.id === proposal.body.leaveId)?.status === 'PROPOSED');

  // ------------------------------------------------------------- phase 2 ----
  console.log('\nPhase 2 — resolve');
  const resolved = await api(`/doctors/${doctorId}/leave/${proposal.body.leaveId}/resolve`, {
    method: 'POST', token: admin,
    body: {
      dispositions: [
        { appointmentId: booked[0], action: 'REBOOK_SAME_DOCTOR', newStartsAt: laterFree[1].startsAt },
        { appointmentId: booked[1], action: 'REBOOK_SAME_DOCTOR', newStartsAt: laterFree[2].startsAt },
        { appointmentId: booked[2], action: 'CANCEL' },
      ],
    },
  });
  check('leave applies once every disposition is valid',
    resolved.status === 200 && resolved.body.status === 'APPLIED',
    `${resolved.status} ${JSON.stringify(resolved.body).slice(0, 200)}`);
  check('all three appointments were handled', resolved.body?.handled === 3);

  const rebooked = await api(`/appointments/${booked[0]}`, { token: patients[0] });
  check('a rebooked appointment is stood down', rebooked.body?.state === 'CANCELLED');
  const cancelledOne = await api(`/appointments/${booked[2]}`, { token: patients[2] });
  check('a cancelled disposition takes effect', cancelledOne.body?.state === 'CANCELLED');

  const mine = await api('/appointments/me', { token: patients[0] });
  check('the patient has a new confirmed appointment at the replacement time',
    (mine.body ?? []).some((a) => a.state === 'CONFIRMED' && a.startsAt === laterFree[1].startsAt));

  const leaveDay = await api(`/doctors/${doctorId}/slots?date=${date}`, { token: patients[0] });
  check('the leave window is no longer bookable',
    leaveDay.body.slots.filter((s) => s.available).length === 0,
    `${leaveDay.body.slots.filter((s) => s.available).length} still available`);

  await sleep(6500);
  const notifs = await api('/admin/notifications', { token: admin });
  const leaveMails = (notifs.body ?? []).filter((n) => n.dedupe_key?.includes(proposal.body.leaveId));
  check('every affected patient was emailed', leaveMails.filter((n) => n.type === 'LEAVE_RESCHEDULED').length === 3,
    `${leaveMails.filter((n) => n.type === 'LEAVE_RESCHEDULED').length} patient emails`);
  check('the doctor received one consolidated summary',
    leaveMails.filter((n) => n.type === 'LEAVE_SUMMARY_DOCTOR').length === 1);

  const reResolve = await api(`/doctors/${doctorId}/leave/${proposal.body.leaveId}/resolve`, {
    method: 'POST', token: admin, body: { dispositions: [] },
  });
  check('an applied leave cannot be resolved twice', reResolve.status === 409, `got ${reResolve.status}`);

  console.log(`\n\x1b[1mResult:\x1b[0m ${passed} passed, ${failed} failed`);
  if (failures.length) { console.log('\nFailures:'); failures.forEach((f) => console.log(`  - ${f}`)); }
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => { console.error('\nLeave test crashed:', e); process.exit(1); });
