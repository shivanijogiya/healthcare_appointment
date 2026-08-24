/**
 * Minimal, transparent SQL migration runner.
 *
 * Each file in ../../migrations is applied once, in filename order, inside a
 * single transaction, and recorded in _migration. Raw SQL is deliberate: the
 * exclusion constraint and the GiST index in 0002 cannot be expressed by any
 * ORM's schema DSL, and a reviewer can read exactly what the database will do.
 */
import '../load-env';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createPool } from '../connection';

const MIGRATIONS_DIR = join(__dirname, '..', '..', 'migrations');

async function main() {
  const pool = createPool();
  const client = await pool.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS _migration (
        name       text PRIMARY KEY,
        applied_at timestamptz NOT NULL DEFAULT now()
      )`);

    const applied = new Set(
      (await client.query<{ name: string }>('SELECT name FROM _migration')).rows.map((r) => r.name),
    );

    const files = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort();
    let count = 0;

    for (const file of files) {
      if (applied.has(file)) {
        console.log(`  = ${file} (already applied)`);
        continue;
      }
      const sqlText = readFileSync(join(MIGRATIONS_DIR, file), 'utf8');
      process.stdout.write(`  + ${file} ... `);
      await client.query('BEGIN');
      try {
        await client.query(sqlText);
        await client.query('INSERT INTO _migration (name) VALUES ($1)', [file]);
        await client.query('COMMIT');
        console.log('ok');
        count++;
      } catch (err) {
        await client.query('ROLLBACK');
        console.log('FAILED');
        throw err;
      }
    }
    console.log(count === 0 ? '\nDatabase already up to date.' : `\nApplied ${count} migration(s).`);
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((e) => {
  console.error('\nMigration failed:', e.message);
  process.exit(1);
});
