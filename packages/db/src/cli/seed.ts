/**
 * Seeds a demo clinic so a reviewer can sign in and exercise every flow
 * immediately. Idempotent: re-running updates rather than duplicating.
 */
import '../load-env';
import bcrypt from 'bcryptjs';
import { getDb, closeDb } from '../connection';

const PASSWORD = process.env.SEED_PASSWORD ?? 'Passw0rd!';

const DOCTORS = [
  {
    email: 'dr.mehta@clinic.test',
    name: 'Dr. Ananya Mehta',
    specialisation: 'General Medicine',
    qualification: 'MBBS, MD (Internal Medicine)',
    slot: 15,
    fee: 600,
    bio: 'Internal medicine, 12 years. Interested in metabolic health and preventive care.',
    hours: { weekdays: ['09:00', '13:00'], extra: ['16:00', '19:00'] },
  },
  {
    email: 'dr.rao@clinic.test',
    name: 'Dr. Vikram Rao',
    specialisation: 'Cardiology',
    qualification: 'MBBS, DM (Cardiology)',
    slot: 30,
    fee: 1200,
    bio: 'Interventional cardiology. Runs the clinic’s hypertension programme.',
    hours: { weekdays: ['10:00', '14:00'], extra: null },
  },
  {
    email: 'dr.fernandes@clinic.test',
    name: 'Dr. Leila Fernandes',
    specialisation: 'Dermatology',
    qualification: 'MBBS, MD (Dermatology)',
    slot: 20,
    fee: 800,
    bio: 'Medical and paediatric dermatology.',
    hours: { weekdays: ['11:00', '17:00'], extra: null },
  },
];

const PATIENTS = [
  { email: 'priya@example.test', name: 'Priya Sharma', dob: '1994-03-17', gender: 'Female' },
  { email: 'arjun@example.test', name: 'Arjun Nair', dob: '1987-11-02', gender: 'Male' },
];

async function main() {
  const db = getDb();
  const hash = await bcrypt.hash(PASSWORD, 10);

  const upsertUser = async (email: string, name: string, role: 'ADMIN' | 'DOCTOR' | 'PATIENT') => {
    const row = await db
      .insertInto('app_user')
      .values({ email, name, role, password_hash: hash })
      .onConflict((oc) => oc.column('email').doUpdateSet({ name, role, password_hash: hash }))
      .returning(['id'])
      .executeTakeFirstOrThrow();
    return row.id;
  };

  // ---- admin ----
  await upsertUser('admin@clinic.test', 'Clinic Administrator', 'ADMIN');

  // ---- doctors ----
  for (const d of DOCTORS) {
    const userId = await upsertUser(d.email, d.name, 'DOCTOR');
    const doc = await db
      .insertInto('doctor')
      .values({
        user_id: userId,
        specialisation: d.specialisation,
        qualification: d.qualification,
        slot_duration_min: d.slot,
        consult_fee: d.fee,
        bio: d.bio,
      })
      .onConflict((oc) =>
        oc.column('user_id').doUpdateSet({
          specialisation: d.specialisation,
          qualification: d.qualification,
          slot_duration_min: d.slot,
          consult_fee: d.fee,
          bio: d.bio,
        }),
      )
      .returning(['id'])
      .executeTakeFirstOrThrow();

    await db.deleteFrom('doctor_availability').where('doctor_id', '=', doc.id).execute();
    const blocks: { weekday: number; start_time: string; end_time: string }[] = [];
    for (let weekday = 1; weekday <= 5; weekday++) {
      blocks.push({ weekday, start_time: d.hours.weekdays[0], end_time: d.hours.weekdays[1] });
      if (d.hours.extra) {
        blocks.push({ weekday, start_time: d.hours.extra[0], end_time: d.hours.extra[1] });
      }
    }
    // Saturday morning clinic
    blocks.push({ weekday: 6, start_time: '09:00', end_time: '12:00' });
    await db
      .insertInto('doctor_availability')
      .values(blocks.map((b) => ({ ...b, doctor_id: doc.id })))
      .execute();
  }

  // ---- patients ----
  for (const p of PATIENTS) {
    const userId = await upsertUser(p.email, p.name, 'PATIENT');
    await db
      .insertInto('patient')
      .values({ user_id: userId, date_of_birth: p.dob, gender: p.gender })
      .onConflict((oc) => oc.column('user_id').doUpdateSet({ date_of_birth: p.dob, gender: p.gender }))
      .execute();
  }

  const counts = {
    doctors: (await db.selectFrom('doctor').select(db.fn.countAll().as('c')).executeTakeFirstOrThrow()).c,
    patients: (await db.selectFrom('patient').select(db.fn.countAll().as('c')).executeTakeFirstOrThrow()).c,
  };

  console.log(`
Seed complete.

  Doctors : ${counts.doctors}
  Patients: ${counts.patients}

  Sign in with password: ${PASSWORD}

    admin@clinic.test          Admin
    dr.mehta@clinic.test       General Medicine, 15 min slots
    dr.rao@clinic.test         Cardiology, 30 min slots
    dr.fernandes@clinic.test   Dermatology, 20 min slots
    priya@example.test         Patient
    arjun@example.test         Patient
`);
  await closeDb();
}

main().catch(async (e) => {
  console.error('Seed failed:', e);
  await closeDb();
  process.exit(1);
});
