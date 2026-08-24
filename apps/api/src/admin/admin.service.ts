import { Inject, Injectable } from '@nestjs/common';
import type { Db } from '@ham/db';
import { DB } from '../db/db.module';
import { OutboxService } from '../notifications/outbox.service';
import { AppError } from '../common/errors/app-error';
import type { AuthUser } from '@ham/types';
import { AuditService } from '../common/audit.service';

@Injectable()
export class AdminService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly outbox: OutboxService,
    private readonly audit: AuditService,
  ) {}

  async overview() {
    const [appointments, outboxStats, llmPre, llmPost, doctors, patients] = await Promise.all([
      this.db.selectFrom('appointment')
        .select(['state', (eb) => eb.fn.countAll<string>().as('count')])
        .groupBy('state').execute(),
      this.outbox.stats(),
      this.db.selectFrom('pre_visit_summary')
        .select(['status', (eb) => eb.fn.countAll<string>().as('count')])
        .groupBy('status').execute(),
      this.db.selectFrom('post_visit_summary')
        .select(['status', (eb) => eb.fn.countAll<string>().as('count')])
        .groupBy('status').execute(),
      this.db.selectFrom('doctor').select((eb) => eb.fn.countAll<string>().as('c')).executeTakeFirst(),
      this.db.selectFrom('patient').select((eb) => eb.fn.countAll<string>().as('c')).executeTakeFirst(),
    ]);

    const tally = (rows: any[], key: string) =>
      Object.fromEntries(rows.map((r) => [r[key], Number(r.count)]));

    return {
      appointments: tally(appointments, 'state'),
      notifications: outboxStats,
      preVisitSummaries: tally(llmPre, 'status'),
      postVisitSummaries: tally(llmPost, 'status'),
      doctors: Number(doctors?.c ?? 0),
      patients: Number(patients?.c ?? 0),
    };
  }

  /** The notification console: everything queued, sent, retrying or dead. */
  notifications(state?: string, limit = 100) {
    return this.outbox.list(state, limit);
  }

  async retryNotification(actor: AuthUser, id: string) {
    const ok = await this.outbox.retry(id);
    if (!ok) throw AppError.conflict('Only a failed or dead notification can be retried.');
    await this.audit.record({
      actor, action: 'notification.retry', entity: 'notification_outbox', entityId: id,
    });
    return { id, state: 'PENDING' as const };
  }

  appointments(state?: string, limit = 200) {
    let q = this.db
      .selectFrom('appointment')
      .innerJoin('doctor', 'doctor.id', 'appointment.doctor_id')
      .innerJoin('app_user as du', 'du.id', 'doctor.user_id')
      .innerJoin('patient', 'patient.id', 'appointment.patient_id')
      .innerJoin('app_user as pu', 'pu.id', 'patient.user_id')
      .select([
        'appointment.id as id',
        'appointment.starts_at as startsAt',
        'appointment.ends_at as endsAt',
        'appointment.state as state',
        'du.name as doctorName',
        'doctor.specialisation as specialisation',
        'pu.name as patientName',
        'pu.email as patientEmail',
      ])
      .orderBy('appointment.starts_at', 'desc')
      .limit(limit);
    if (state) q = q.where('appointment.state', '=', state as any);
    return q.execute();
  }

  auditLog(limit = 200) {
    return this.db
      .selectFrom('audit_log')
      .leftJoin('app_user', 'app_user.id', 'audit_log.actor_id')
      .select([
        'audit_log.id as id', 'audit_log.action as action', 'audit_log.entity as entity',
        'audit_log.entity_id as entityId', 'audit_log.metadata as metadata',
        'audit_log.created_at as createdAt', 'app_user.name as actorName',
        'audit_log.actor_role as actorRole',
      ])
      .orderBy('audit_log.created_at', 'desc')
      .limit(limit)
      .execute();
  }

  patients(limit = 200) {
    return this.db
      .selectFrom('patient')
      .innerJoin('app_user', 'app_user.id', 'patient.user_id')
      .select([
        'patient.id as id', 'app_user.name as name', 'app_user.email as email',
        'patient.gender as gender', 'patient.date_of_birth as dateOfBirth',
        'app_user.created_at as createdAt',
      ])
      .orderBy('app_user.created_at', 'desc')
      .limit(limit)
      .execute();
  }
}
