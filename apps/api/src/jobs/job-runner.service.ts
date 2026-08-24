import { Injectable, Logger, OnApplicationShutdown, OnModuleInit } from '@nestjs/common';
import { Worker, Queue, Job } from 'bullmq';
import { sql, type Db } from '@ham/db';
import { Inject } from '@nestjs/common';
import { DB } from '../db/db.module';
import { RedisService } from '../queue/redis.service';
import { QUEUE, CalendarSyncJob } from '../queue/queue.constants';
import { OutboxService } from '../notifications/outbox.service';
import { MailerService, isPermanentFailure } from '../notifications/mailer.service';
import { renderEmail } from '../notifications/templates';
import { SummaryService } from '../llm/summary.service';
import { VisitsService } from '../visits/visits.service';
import { CalendarService } from '../calendar/calendar.service';

/**
 * All queue consumers, in the worker process only.
 *
 * The API never registers a Worker, so a stuck LLM call or a hanging SMTP
 * connection consumes worker capacity and nothing else. Booking stays
 * responsive while every integration behind it is failing.
 */
@Injectable()
export class JobRunner implements OnModuleInit, OnApplicationShutdown {
  private readonly logger = new Logger('Worker');
  private readonly workers: Worker[] = [];
  private readonly schedulers: Queue[] = [];

  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly redis: RedisService,
    private readonly outbox: OutboxService,
    private readonly mailer: MailerService,
    private readonly summaries: SummaryService,
    private readonly visits: VisitsService,
    private readonly calendar: CalendarService,
  ) {}

  async onModuleInit() {
    this.consume(QUEUE.OUTBOX_DRAIN, 5, () => this.drainOutbox());
    this.consume(QUEUE.HOLD_SWEEP, 1, () => this.sweepHolds());
    this.consume(QUEUE.MEDICATION_TICK, 3, () => this.visits.dispatchDueMedicationReminders());
    this.consume(QUEUE.CALENDAR_RECONCILE, 1, () => this.calendar.reconcile());
    this.consume(QUEUE.LLM_RETRY_SWEEP, 1, () => this.summaries.retryFailed());

    this.consume(QUEUE.LLM_PREVISIT, 3, (job) =>
      this.summaries.generatePreVisit(job.data.appointmentId));
    this.consume(QUEUE.LLM_POSTVISIT, 3, (job) =>
      this.summaries.generatePostVisit(job.data.visitNoteId));
    this.consume(QUEUE.MEDICATION_FANOUT, 5, (job) =>
      this.visits.fanOutMedicationReminders(job.data.visitNoteId));
    this.consume(QUEUE.CALENDAR_SYNC, 3, (job) => {
      const { appointmentId, action } = job.data as CalendarSyncJob;
      return this.calendar.sync(appointmentId, action);
    });

    await this.scheduleRepeatables();
    this.logger.log(`Worker ready — ${this.workers.length} queues consuming`);
  }

  private consume(name: string, concurrency: number, handler: (job: Job) => Promise<unknown>) {
    const worker = new Worker(name, async (job) => handler(job), {
      connection: this.redis.create(),
      concurrency,
    });
    worker.on('failed', (job, err) =>
      this.logger.error(`${name}#${job?.id} failed: ${err.message}`));
    this.workers.push(worker);
  }

  /**
   * Repeatable jobs are registered with a stable key so restarting the worker
   * re-uses the same schedule instead of stacking duplicates.
   */
  private async scheduleRepeatables() {
    const plan: [string, number][] = [
      [QUEUE.OUTBOX_DRAIN, 5_000],
      [QUEUE.HOLD_SWEEP, 30_000],
      [QUEUE.MEDICATION_TICK, 60_000],
      [QUEUE.CALENDAR_RECONCILE, 15 * 60_000],
      [QUEUE.LLM_RETRY_SWEEP, 60 * 60_000],
    ];
    for (const [name, every] of plan) {
      const queue = new Queue(name, { connection: this.redis.create() });
      await queue.add('tick', {}, {
        repeat: { every },
        jobId: `repeat-${name}`,
        removeOnComplete: { count: 20 },
        removeOnFail: { count: 50 },
      });
      this.schedulers.push(queue);
    }
  }

  // ------------------------------------------------------------- handlers ---

  /**
   * Claims a batch and sends it. Failures follow the backoff ladder; a hard
   * bounce or an undeliverable address skips straight to DEAD rather than
   * burning four more attempts on an address that will never work.
   */
  private async drainOutbox(): Promise<{ sent: number; failed: number }> {
    await this.outbox.reclaimStale();
    const batch = await this.outbox.claimBatch(50);
    let sent = 0;
    let failed = 0;

    for (const row of batch) {
      try {
        if (await this.isStale(row)) {
          await this.outbox.markFailed(row, 'Dropped: the appointment had already started', true);
          continue;
        }
        const payload = typeof row.payload === 'string' ? JSON.parse(row.payload) : row.payload;
        const email = renderEmail(row.type, payload ?? {});
        const result = await this.mailer.send(row.recipient_email, email);
        await this.outbox.markSent(row.id, result.messageId);
        sent++;
      } catch (err) {
        await this.outbox.markFailed(row, (err as Error).message, isPermanentFailure(err));
        failed++;
      }
    }
    if (sent || failed) this.logger.log(`Outbox drained: ${sent} sent, ${failed} failed`);
    return { sent, failed };
  }

  /**
   * A reminder for an appointment that has already begun is worse than no
   * reminder, so it is dropped rather than delivered late.
   */
  private async isStale(row: { type: string; dedupe_key: string }): Promise<boolean> {
    if (row.type !== 'REMINDER_24H') return false;
    const appointmentId = row.dedupe_key.split(':')[0];
    const appt = await this.db
      .selectFrom('appointment').select(['starts_at', 'state'])
      .where('id', '=', appointmentId).executeTakeFirst();
    if (!appt) return true;
    return new Date(appt.starts_at) <= new Date() || appt.state !== 'CONFIRMED';
  }

  /**
   * Deletes holds whose TTL lapsed.
   *
   * This is housekeeping, not correctness: slot computation already ignores an
   * expired hold, and confirm() re-checks the expiry in its WHERE clause. If
   * this job never ran, the system would still book correctly — it would just
   * accumulate dead rows.
   */
  private async sweepHolds(): Promise<number> {
    const res = await this.db
      .deleteFrom('appointment')
      .where('state', '=', 'HELD')
      .where('hold_expires_at', '<', new Date())
      .executeTakeFirst();
    const n = Number(res.numDeletedRows ?? 0);
    if (n) this.logger.log(`Swept ${n} expired hold(s)`);
    return n;
  }

  async onApplicationShutdown() {
    await Promise.allSettled([
      ...this.workers.map((w) => w.close()),
      ...this.schedulers.map((q) => q.close()),
    ]);
  }
}
