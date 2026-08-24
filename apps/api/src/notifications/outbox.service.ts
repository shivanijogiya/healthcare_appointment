import { Inject, Injectable, Logger } from '@nestjs/common';
import { sql, type Db } from '@ham/db';
import type { Transaction } from 'kysely';
import type { Database, NotificationOutbox } from '@ham/db';
import { DB } from '../db/db.module';
import { NotificationType } from '../common/enums';

export interface OutboxDraft {
  type: NotificationType | string;
  recipientEmail: string;
  recipientName?: string | null;
  payload: Record<string, unknown>;
  /** Stable idempotency key. The same key twice produces one email, ever. */
  dedupeKey: string;
  scheduledFor?: Date;
}

/** Backoff ladder: attempt 1 immediate, then +1m, +5m, +30m, +2h, then DEAD. */
export const RETRY_DELAYS_MINUTES = [0, 1, 5, 30, 120];
export const MAX_ATTEMPTS = RETRY_DELAYS_MINUTES.length;

export function nextRetryAt(attempts: number, from: Date): Date | null {
  if (attempts >= MAX_ATTEMPTS) return null;
  return new Date(from.getTime() + RETRY_DELAYS_MINUTES[attempts] * 60_000);
}

type Trx = Transaction<Database> | Db;

@Injectable()
export class OutboxService {
  private readonly logger = new Logger(OutboxService.name);
  constructor(@Inject(DB) private readonly db: Db) {}

  /**
   * Writes notification intent inside the caller's transaction.
   *
   * This is the entire point of the outbox: the row that says "email this
   * patient" commits atomically with the row that says "this appointment is
   * confirmed". There is no window in which a booking exists but its
   * confirmation was lost to a crash between COMMIT and the SMTP call.
   *
   * ON CONFLICT DO NOTHING makes a replayed transaction a no-op instead of a
   * duplicate send.
   */
  async enqueue(trx: Trx, drafts: OutboxDraft | OutboxDraft[]): Promise<void> {
    const list = Array.isArray(drafts) ? drafts : [drafts];
    if (!list.length) return;
    await trx
      .insertInto('notification_outbox')
      .values(
        list.map((d) => ({
          type: String(d.type),
          recipient_email: d.recipientEmail,
          recipient_name: d.recipientName ?? null,
          payload: JSON.stringify(d.payload),
          dedupe_key: d.dedupeKey,
          scheduled_for: d.scheduledFor ?? new Date(),
        })),
      )
      .onConflict((oc) => oc.column('dedupe_key').doNothing())
      .execute();
  }

  /**
   * Claims a batch of due rows for this worker.
   *
   * FOR UPDATE SKIP LOCKED lets N worker replicas drain the same table at once:
   * each row goes to exactly one worker and the others step over it rather than
   * blocking behind it. The flip to SENDING happens in the same statement, so a
   * crash mid-send leaves a row that reclaimStale() can safely recover.
   */
  async claimBatch(limit = 50): Promise<NotificationOutbox[]> {
    const { rows } = await sql<NotificationOutbox>`
      WITH claimed AS (
        SELECT id FROM notification_outbox
         WHERE state = 'PENDING' AND scheduled_for <= now()
         ORDER BY scheduled_for
         FOR UPDATE SKIP LOCKED
         LIMIT ${limit}
      )
      UPDATE notification_outbox o
         SET state = 'SENDING', locked_at = now()
        FROM claimed
       WHERE o.id = claimed.id
      RETURNING o.*
    `.execute(this.db);
    return rows;
  }

  async markSent(id: string, providerMsgId?: string): Promise<void> {
    await this.db
      .updateTable('notification_outbox')
      .set({
        state: 'SENT',
        sent_at: new Date(),
        provider_msg_id: providerMsgId ?? null,
        last_error: null,
        locked_at: null,
      })
      .where('id', '=', id)
      .execute();
  }

  /** Retry with backoff, or bury in DEAD once the ladder is exhausted. */
  async markFailed(row: NotificationOutbox, error: string, permanent = false): Promise<void> {
    const attempts = row.attempts + 1;
    const retryAt = permanent ? null : nextRetryAt(attempts, new Date());
    await this.db
      .updateTable('notification_outbox')
      .set({
        state: retryAt ? 'PENDING' : 'DEAD',
        attempts,
        last_error: error.slice(0, 500),
        locked_at: null,
        scheduled_for: retryAt ?? row.scheduled_for,
      })
      .where('id', '=', row.id)
      .execute();

    if (!retryAt) {
      this.logger.error(
        `Outbox ${row.id} (${row.type} -> ${row.recipient_email}) is DEAD after ${attempts}: ${error}`,
      );
    }
  }

  /** A worker that died mid-send leaves rows stuck in SENDING. Reclaim them. */
  async reclaimStale(olderThanMs = 5 * 60_000): Promise<number> {
    const res = await this.db
      .updateTable('notification_outbox')
      .set({ state: 'PENDING', locked_at: null })
      .where('state', '=', 'SENDING')
      .where('locked_at', '<', new Date(Date.now() - olderThanMs))
      .executeTakeFirst();
    return Number(res.numUpdatedRows ?? 0);
  }

  async list(state: string | undefined, limit = 100) {
    let q = this.db.selectFrom('notification_outbox').selectAll();
    if (state) q = q.where('state', '=', state as any);
    return q.orderBy('created_at', 'desc').limit(limit).execute();
  }

  /** Manual retry from the admin console: reset the ladder and send now. */
  async retry(id: string): Promise<boolean> {
    const res = await this.db
      .updateTable('notification_outbox')
      .set({ state: 'PENDING', attempts: 0, scheduled_for: new Date(), last_error: null, locked_at: null })
      .where('id', '=', id)
      .where('state', 'in', ['DEAD', 'FAILED'])
      .executeTakeFirst();
    return Number(res.numUpdatedRows ?? 0) > 0;
  }

  async stats(): Promise<Record<string, number>> {
    const rows = await this.db
      .selectFrom('notification_outbox')
      .select(['state', (eb) => eb.fn.countAll<string>().as('count')])
      .groupBy('state')
      .execute();
    return Object.fromEntries(rows.map((r) => [r.state as string, Number(r.count)]));
  }
}
