-- 0002_no_double_booking.sql
-- The single most important object in this database.
--
-- A GiST exclusion constraint over (doctor_id, time range) makes it physically
-- impossible for two live appointments of the same doctor to overlap. This is
-- enforced by Postgres inside the same lock that performs the INSERT, so it holds
-- under any level of concurrency, across any number of API instances, with no
-- application-level locking, no SELECT-then-INSERT race window, and no advisory
-- locks to leak.
--
-- btree_gist is required because doctor_id is a uuid (btree-style equality) and
-- must sit in the same GiST index as the range overlap operator.
CREATE EXTENSION IF NOT EXISTS btree_gist;

ALTER TABLE appointment
  ADD CONSTRAINT no_double_booking
  EXCLUDE USING gist (
    doctor_id WITH =,
    tstzrange(starts_at, ends_at, '[)') WITH &&
  )
  WHERE (state IN ('HELD', 'CONFIRMED'));

-- '[)' bounds mean a 09:15 end and a 09:15 start do NOT overlap: back-to-back
-- slots are legal, which is the whole point of a slot grid.
--
-- The partial WHERE clause means CANCELLED / COMPLETED / NO_SHOW rows are not in
-- the index, so a cancelled 09:00 slot is immediately rebookable and history is
-- retained rather than deleted.

-- A patient should not be in two places at once either.
ALTER TABLE appointment
  ADD CONSTRAINT no_patient_overlap
  EXCLUDE USING gist (
    patient_id WITH =,
    tstzrange(starts_at, ends_at, '[)') WITH &&
  )
  WHERE (state IN ('HELD', 'CONFIRMED'));
