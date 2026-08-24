import '../load-env';
import { createPool } from '../connection';

async function main() {
  if (process.env.NODE_ENV === 'production' && !process.env.ALLOW_PROD_RESET) {
    throw new Error('Refusing to drop the schema in production.');
  }
  const pool = createPool();
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await pool.end();
  console.log('Schema dropped and recreated. Run `npm run migrate` next.');
}
main().catch((e) => { console.error(e.message); process.exit(1); });
