/**
 * The double-booking proof.
 *
 * Fires N simultaneous hold requests at a single slot and asserts that exactly
 * one succeeds, every other gets 409 SLOT_TAKEN, and the database contains
 * exactly one live row for that slot.
 *
 * There is no application-level lock anywhere in the booking path. The
 * guarantee comes entirely from the Postgres GiST exclusion constraint in
 * migration 0002, which is evaluated inside the same lock as the INSERT.
 *
 * Run with: node tests/concurrency.mjs [attempts]
 */
import pg from 'pg';

const API = process.env.API_URL ?? 'http://localhost:3000';
const DATABASE_URL = process.env.DATABASE_URL ?? 'postgresql://ham:ham@127.0.0.1:5432/ham';
const ATTEMPTS = Number(process.argv[2] ?? 50);

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

function nextWeekday(target = 3) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + 1);
  while (d.getUTCDay() !== target) d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

async function main() {
  console.log(`\n\x1b[1mConcurrency test — ${ATTEMPTS} simultaneous holds on one slot\x1b[0m\n`);

  // Register ATTEMPTS distinct patients. Using distinct patients is the honest
  // version of this test: identical patients would also collide on the
  // no_patient_overlap constraint, which would prove the wrong thing.
  process.stdout.write(`Registering ${ATTEMPTS} patients... `);
  const stamp = Date.now();
  const tokens = await Promise.all(
    Array.from({ length: ATTEMPTS }, async (_, i) => {
      const r = await api('/auth/register', {
        method: 'POST',
        body: {
          email: `race-${stamp}-${i}@example.test`,
          password: 'Passw0rd!',
          name: `Race Patient ${i}`,
        },
      });
      return r.body?.accessToken;
    }),
  );
  console.log(`done (${tokens.filter(Boolean).length} tokens)`);

  const doctors = await api('/doctors', { token: tokens[0] });
  const doctor = doctors.body[0];
  const date = nextWeekday(3);
  const grid = await api(`/doctors/${doctor.id}/slots?date=${date}`, { token: tokens[0] });
  const slot = grid.body.slots.find((s) => s.available);
  if (!slot) throw new Error(`No free slot on ${date} for ${doctor.name}`);

  console.log(`Target: ${doctor.name} — ${slot.startsAt}\n`);

  // Fire them all at once. Promise.all with pre-built requests means the
  // requests leave together rather than being paced by the event loop.
  const started = Date.now();
  const results = await Promise.all(
    tokens.map((token) =>
      api('/appointments/hold', {
        method: 'POST',
        token,
        body: { doctorId: doctor.id, startsAt: slot.startsAt },
      }).catch((e) => ({ status: 0, body: { error: e.message } })),
    ),
  );
  const elapsed = Date.now() - started;

  const created = results.filter((r) => r.status === 201);
  const taken = results.filter((r) => r.status === 409 && r.body?.code === 'SLOT_TAKEN');
  const other = results.filter((r) => r.status !== 201 && !(r.status === 409 && r.body?.code === 'SLOT_TAKEN'));

  // The database is the real verdict, not the HTTP responses.
  const client = new pg.Client({ connectionString: DATABASE_URL });
  await client.connect();
  const { rows } = await client.query(
    `SELECT count(*)::int AS live
       FROM appointment
      WHERE doctor_id = $1 AND starts_at = $2 AND state IN ('HELD','CONFIRMED')`,
    [doctor.id, slot.startsAt],
  );
  await client.end();
  const liveRows = rows[0].live;

  console.log('Results');
  console.log(`  201 Created            ${created.length}`);
  console.log(`  409 SLOT_TAKEN         ${taken.length}`);
  console.log(`  unexpected responses   ${other.length}`);
  console.log(`  live rows in database  ${liveRows}`);
  console.log(`  elapsed                ${elapsed}ms\n`);

  if (other.length) {
    console.log('Unexpected responses:');
    for (const r of other.slice(0, 5)) {
      console.log(`  ${r.status} ${JSON.stringify(r.body).slice(0, 160)}`);
    }
    console.log();
  }

  const checks = [
    ['exactly one request succeeded', created.length === 1],
    [`the other ${ATTEMPTS - 1} were refused with SLOT_TAKEN`, taken.length === ATTEMPTS - 1],
    ['no unexpected responses', other.length === 0],
    ['exactly one live row exists in the database', liveRows === 1],
  ];

  let ok = true;
  for (const [name, pass] of checks) {
    console.log(`  ${pass ? '\x1b[32mPASS\x1b[0m' : '\x1b[31mFAIL\x1b[0m'} ${name}`);
    if (!pass) ok = false;
  }

  console.log(
    ok
      ? '\n\x1b[32mNo double booking is possible.\x1b[0m Enforced by the ' +
        'no_double_booking exclusion constraint, with no application locking.\n'
      : '\n\x1b[31mConcurrency guarantee violated.\x1b[0m\n',
  );
  process.exit(ok ? 0 : 1);
}

main().catch((e) => {
  console.error('Concurrency test crashed:', e);
  process.exit(1);
});
