import { Injectable, Logger } from '@nestjs/common';
import { createCipheriv, createDecipheriv, randomBytes, createHash } from 'node:crypto';
import { loadConfig } from '../config/env';

/**
 * AES-256-GCM for Google refresh tokens. A refresh token is a long-lived key to
 * somebody's calendar; it must never sit in the database as plaintext.
 * Format: base64(iv).base64(authTag).base64(ciphertext)
 */
@Injectable()
export class CryptoService {
  private readonly logger = new Logger(CryptoService.name);
  private readonly key: Buffer;

  constructor() {
    const raw = loadConfig().ENCRYPTION_KEY;
    if (/^[0-9a-f]{64}$/i.test(raw)) {
      this.key = Buffer.from(raw, 'hex');
    } else {
      this.logger.warn('ENCRYPTION_KEY is not 32 bytes of hex — deriving one. Set it properly before production.');
      this.key = createHash('sha256').update(raw || 'insecure-dev-key').digest();
    }
  }

  encrypt(plain: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    const ct = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
    return [iv.toString('base64'), cipher.getAuthTag().toString('base64'), ct.toString('base64')].join('.');
  }

  decrypt(payload: string): string {
    const [iv, tag, ct] = payload.split('.');
    const decipher = createDecipheriv('aes-256-gcm', this.key, Buffer.from(iv, 'base64'));
    decipher.setAuthTag(Buffer.from(tag, 'base64'));
    return Buffer.concat([decipher.update(Buffer.from(ct, 'base64')), decipher.final()]).toString('utf8');
  }

  sha256(v: string): string { return createHash('sha256').update(v).digest('hex'); }
}
