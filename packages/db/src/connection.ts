import { Kysely, PostgresDialect, sql } from 'kysely';
import { Pool, types } from 'pg';
import type { Database } from './schema';

// numeric(10,2) -> keep as string to avoid float drift on money; callers parse.
types.setTypeParser(1700, (v: string) => v);

export type Db = Kysely<Database>;

let pool: Pool | undefined;
let instance: Db | undefined;

export function createPool(connectionString = process.env.DATABASE_URL): Pool {
  if (!connectionString) throw new Error('DATABASE_URL is not set');
  return new Pool({
    connectionString,
    max: Number(process.env.DB_POOL_MAX ?? 10),
    ssl: /sslmode=require/.test(connectionString) ? { rejectUnauthorized: false } : undefined,
  });
}

export function getDb(): Db {
  if (!instance) {
    pool = createPool();
    instance = new Kysely<Database>({ dialect: new PostgresDialect({ pool }) });
  }
  return instance;
}

export async function closeDb(): Promise<void> {
  if (instance) {
    await instance.destroy();
    instance = undefined;
    pool = undefined;
  }
}

/** Postgres SQLSTATEs we translate into domain errors rather than 500s. */
export const PG = {
  EXCLUSION_VIOLATION: '23P01',
  UNIQUE_VIOLATION: '23505',
  CHECK_VIOLATION: '23514',
  FOREIGN_KEY_VIOLATION: '23503',
} as const;

export interface PgError extends Error {
  code?: string;
  constraint?: string;
  detail?: string;
}

export function pgCode(e: unknown): string | undefined {
  return (e as PgError | undefined)?.code;
}

export function pgConstraint(e: unknown): string | undefined {
  return (e as PgError | undefined)?.constraint;
}

export async function ping(db: Db): Promise<boolean> {
  await sql`select 1`.execute(db);
  return true;
}

export { sql };
