import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import * as fs from 'fs';
import * as path from 'path';
import * as nodemailer from 'nodemailer';
import { loadConfig } from '../config/env';
import { RenderedEmail } from './templates';

export class PermanentMailError extends Error {
  readonly permanent = true;
}

export interface SendResult {
  messageId: string;
}

/**
 * One interface, three transports:
 *   smtp    — real delivery (SendGrid, Mailgun, Gmail, anything with SMTP)
 *   file    — writes .html files to disk so the whole flow is demoable with zero setup
 *   failing — always throws; used by the failure-injection tests
 */
@Injectable()
export class MailerService implements OnModuleInit {
  private readonly logger = new Logger(MailerService.name);
  private readonly config = loadConfig();
  private transport: nodemailer.Transporter | null = null;

  onModuleInit() {
    if (this.mode === 'smtp') {
      this.transport = nodemailer.createTransport({
        host: this.config.SMTP_HOST,
        port: this.config.SMTP_PORT,
        secure: this.config.SMTP_SECURE,
        auth:
          this.config.SMTP_USER && this.config.SMTP_PASS
            ? { user: this.config.SMTP_USER, pass: this.config.SMTP_PASS }
            : undefined,
      });
      this.logger.log(`Email transport: SMTP ${this.config.SMTP_HOST}:${this.config.SMTP_PORT}`);
    } else if (this.mode === 'file') {
      fs.mkdirSync(this.outputDir, { recursive: true });
      this.logger.log(`Email transport: file (${this.outputDir})`);
    } else {
      this.logger.warn('Email transport: failing (failure-injection mode)');
    }
  }

  private get mode(): 'smtp' | 'file' | 'failing' {
    if (this.config.MAIL_TRANSPORT === 'smtp' && !this.config.SMTP_HOST) return 'file';
    return this.config.MAIL_TRANSPORT;
  }

  private get outputDir(): string {
    return path.resolve(process.cwd(), this.config.MAIL_OUTPUT_DIR);
  }

  async send(to: string, email: RenderedEmail): Promise<SendResult> {
    if (!isPlausibleEmail(to)) {
      throw new PermanentMailError(`Recipient address "${to}" is not deliverable.`);
    }

    if (this.mode === 'failing') throw new Error('Injected SMTP failure');

    if (this.mode === 'file') {
      fs.mkdirSync(this.outputDir, { recursive: true });
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      const safe = to.replace(/[^a-z0-9]/gi, '_');
      const file = path.join(this.outputDir, `${stamp}__${safe}.html`);
      fs.writeFileSync(
        file,
        `<!-- To: ${to}\n     Subject: ${email.subject} -->\n${email.html}`,
        'utf8',
      );
      this.logger.log(`Email written: ${path.basename(file)} → ${to} — ${email.subject}`);
      return { messageId: `file:${path.basename(file)}` };
    }

    const info = await this.transport!.sendMail({
      from: this.config.MAIL_FROM,
      to,
      subject: email.subject,
      html: email.html,
      text: email.text,
    });
    return { messageId: info.messageId ?? 'sent' };
  }
}

export function isPlausibleEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/.test(value.trim());
}

export function isPermanentFailure(error: unknown): boolean {
  if (error instanceof PermanentMailError) return true;
  const code = (error as any)?.responseCode;
  return typeof code === 'number' && code >= 500 && code < 600;
}
