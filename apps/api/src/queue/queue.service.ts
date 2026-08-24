import { Injectable, Logger, OnApplicationShutdown } from '@nestjs/common';
import { Queue, JobsOptions } from 'bullmq';
import { RedisService } from './redis.service';
import { QUEUE, QueueName, CalendarSyncJob } from './queue.constants';

const DEFAULTS: JobsOptions = {
  attempts: 3,
  backoff: { type: 'exponential', delay: 2000 },
  removeOnComplete: { count: 200 },
  removeOnFail: { count: 500 },
};

/**
 * Producer side only. Consumers live in the worker process (src/worker.ts) so a
 * wedged LLM or SMTP job can never consume the API's event loop.
 *
 * Every enqueue here happens AFTER the database transaction commits. If the
 * enqueue itself fails, the business state is still correct and a reconciliation
 * sweeper picks the work up — queues are an accelerator, not a source of truth.
 */
@Injectable()
export class QueueService implements OnApplicationShutdown {
  private readonly logger = new Logger(QueueService.name);
  private readonly queues = new Map<QueueName, Queue>();

  constructor(private readonly redis: RedisService) {}

  queue(name: QueueName): Queue {
    let q = this.queues.get(name);
    if (!q) {
      q = new Queue(name, { connection: this.redis.create(), defaultJobOptions: DEFAULTS });
      this.queues.set(name, q);
    }
    return q;
  }

  /** Never throws — a failed enqueue must not roll back a committed booking. */
  private async safeAdd(name: QueueName, jobName: string, data: unknown, opts?: JobsOptions) {
    try {
      await this.queue(name).add(jobName, data, opts);
    } catch (e) {
      this.logger.error(`Enqueue to ${name} failed (sweeper will recover): ${(e as Error).message}`);
    }
  }

  preVisitSummary(appointmentId: string) {
    return this.safeAdd(QUEUE.LLM_PREVISIT, 'generate', { appointmentId }, { jobId: `previsit-${appointmentId}` });
  }

  postVisitSummary(visitNoteId: string) {
    return this.safeAdd(QUEUE.LLM_POSTVISIT, 'generate', { visitNoteId }, { jobId: `postvisit-${visitNoteId}` });
  }

  medicationFanout(visitNoteId: string) {
    return this.safeAdd(QUEUE.MEDICATION_FANOUT, 'fanout', { visitNoteId }, { jobId: `fanout-${visitNoteId}` });
  }

  calendarSync(job: CalendarSyncJob) {
    return this.safeAdd(QUEUE.CALENDAR_SYNC, job.action, job, {
      jobId: `cal-${job.appointmentId}-${job.action}-${Date.now()}`,
    });
  }

  // BullMQ rejects ':' in a custom job id, so ids use '-' as the separator.

  /** Nudges the drain loop so a confirmation email goes out in ~0ms, not ~5s. */
  drainOutboxNow() {
    return this.safeAdd(QUEUE.OUTBOX_DRAIN, 'nudge', {});
  }

  async counts() {
    const out: Record<string, unknown> = {};
    for (const name of Object.values(QUEUE)) {
      try {
        out[name] = await this.queue(name).getJobCounts('waiting', 'active', 'failed', 'delayed');
      } catch {
        out[name] = 'unavailable';
      }
    }
    return out;
  }

  async onApplicationShutdown() {
    await Promise.allSettled([...this.queues.values()].map((q) => q.close()));
  }
}
