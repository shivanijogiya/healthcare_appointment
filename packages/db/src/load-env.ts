import * as fs from 'node:fs';
import * as path from 'node:path';
import * as dotenv from 'dotenv';

/**
 * The CLIs run from packages/db, but .env lives at the repository root, so walk
 * upwards until one is found. Imported for its side effect before anything reads
 * process.env.
 */
const candidates = [
  path.resolve(process.cwd(), '.env'),
  path.resolve(process.cwd(), '..', '..', '.env'),
  path.resolve(__dirname, '..', '.env'),
  path.resolve(__dirname, '..', '..', '..', '.env'),
  path.resolve(__dirname, '..', '..', '..', '..', '.env'),
];

for (const file of candidates) {
  if (fs.existsSync(file)) {
    dotenv.config({ path: file });
    break;
  }
}
