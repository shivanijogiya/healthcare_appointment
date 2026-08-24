import * as fs from 'fs';
import * as path from 'path';
import * as dotenv from 'dotenv';

/**
 * Loaded before any other application import so that modules which read config
 * at construction time (JwtModule, BullMQ) see a fully populated environment.
 */
const candidates = [
  path.resolve(process.cwd(), '.env'),
  path.resolve(process.cwd(), '../../.env'),
  path.resolve(__dirname, '../../.env'),
  path.resolve(__dirname, '../../../../.env'),
];

for (const file of candidates) {
  if (fs.existsSync(file)) {
    dotenv.config({ path: file });
    break;
  }
}
