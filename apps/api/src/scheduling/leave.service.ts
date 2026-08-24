import { Inject, Injectable, Logger } from '@nestjs/common';
import { PG, pgCode, type Db } from '@ham/db';
import type { AuthUser, LeaveConflict } from '@ham/types';
import { DB } from '../db/db.module';
import { AppError } from '../common/errors/app-error';
import { ClockService } from '../common/clock.service';
import { AuditService } from '../common/audit.service';
import { OutboxService } from '../notifications/outbox.service';
import * as drafts from '../notifications/drafts';
import { QueueService } from '../queue/queue.service';
import { SlotsService } from './slots.service';
import { ProposeLeaveDto, ResolveLeaveDto, DispositionDto } from './dto';

/**
 * Leave is a two-phase operation and never a single destructive write.
 *
 * Phase 1 (propose) records the intent as PROPOSED and returns the list of
 * patients it would strand — nothing is committed to those patients yet.
 * Phase 2 (resolve) applies an explicit disposition for every conflict inside
 * one transaction.
 *
 * The reason is simple: marking a doctor unavailable is trivial, but silently
 * orphaning eight booked patients is the actual problem, and a system that
 * cancels first and asks later has already sent the emails by the time anyone
 * notices.
 */
@Injectable()
export class LeaveService {
  private readonly logger = new Logger(LeaveService.name);

  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly slots: SlotsService,
    private readonly clock: ClockService,
    private readonly outbox: OutboxService,
    private readonly queue: QueueService,
    private readonly audit: AuditService,
  ) {}

  // ------------------------------------------------------------- propose ----

  async propose(user: AuthUser, doctorId: string, dto: ProposeLeaveDto) {
    this.assertDoctorScope(user, doctorId);

    const startsAt = new Date(dto.startsAt);
    const endsAt = new Date(dto.endsAt);
    if (endsAt <= startsAt) throw AppError.conflict('Leave must end after it starts.');

    const leave = await this.db
      .insertInto('doctor_leave')
      .values({
        doctor_id: doctorId,
        starts_at: startsAt,
        ends_at: endsAt,
        reason: dto.reason ?? null,
        status: 'PROPOSED',
        created_by: user.id,
      })
      .returningAll()
      .executeTakeFirstOrThrow();

    const conflicts = await this.conflictsFor(doctorId, startsAt, endsAt);

    await this.audit.record({
      actor: user, action: 'leave.propose', entity: 'doctor_leave', entityId: leave.id,
      metadata: { conflicts: conflicts.length },
    });

    return {
      leaveId: leave.id,
      doctorId,
      startsAt: startsAt.toISOString(),
      endsAt: endsAt.toISOString(),
      status: 'PROPOSED' as const,
      conflicts,
      /** A convenience the admin UI pre-fills the disposition form with. */
      suggestions: await this.suggestFor(doctorId, conflicts, endsAt),
    };
  }

  /** Live appointments that the proposed leave window would strand. */
  private async conflictsFor(doctorId: string, startsAt: Date, endsAt: Date): Promise<LeaveConflict[]> {
    const rows = await this.db
      .selectFrom('appointment')
      .innerJoin('patient', 'patient.id', 'appointment.patient_id')
      .innerJoin('app_user as pu', 'pu.id', 'patient.user_id')
      .select([
        'appointment.id as id',
        'appointment.starts_at as startsAt',
        'appointment.ends_at as endsAt',
        'appointment.state as state',
        'pu.name as patientName',
        'pu.email as patientEmail',
      ])
      .where('appointment.doctor_id', '=', doctorId)
      .where('appointment.state', 'in', ['HELD', 'CONFIRMED'])
      .where('appointment.starts_at', '<', endsAt)
      .where('appointment.ends_at', '>', startsAt)
      .orderBy('appointment.starts_at')
      .execute();

    return rows.map((r) => ({
      appointmentId: r.id,
      startsAt: new Date(r.startsAt).toISOString(),
      endsAt: new Date(r.endsAt).toISOString(),
      patientName: r.patientName,
      patientEmail: r.patientEmail,
      state: r.state,
    }));
  }

  /** Proposes the first free slot after the leave for each conflict. */
  private async suggestFor(doctorId: string, conflicts: LeaveConflict[], after: Date) {
    const out: Record<string, string | null> = {};
    // Walk forward from the end of leave, remembering what we've provisionally
    // handed out so two conflicts don't get suggested the same slot.
    const taken = new Set<number>();
    for (const c of conflicts) {
      let cursor = new Date(after);
      let pick: string | null = null;
      for (let i = 0; i < 5; i++) {
        const free = await this.slots.findNextFree(doctorId, cursor);
        if (!free) break;
        if (!taken.has(free.startsAt.getTime())) {
          taken.add(free.startsAt.getTime());
          pick = free.startsAt.toISOString();
          break;
        }
        cursor = new Date(free.startsAt.getTime() + 60_000);
      }
      out[c.appointmentId] = pick;
    }
    return out;
  }

  // ------------------------------------------------------------- resolve ----

  /**
   * Applies the leave and every disposition in one transaction.
   *
   * Each replacement booking is an ordinary INSERT and is therefore subject to
   * the same exclusion constraint as any other booking — a rebook can itself
   * lose a race. When that happens the entire transaction rolls back and the
   * admin is told exactly which one failed. Partial application is not allowed:
   * a half-applied leave leaves the doctor unavailable with patients still on
   * the books, which is worse than no change at all.
   */
  async resolve(user: AuthUser, doctorId: string, leaveId: string, dto: ResolveLeaveDto) {
    this.assertDoctorScope(user, doctorId);

    const leave = await this.db
      .selectFrom('doctor_leave').selectAll()
      .where('id', '=', leaveId).where('doctor_id', '=', doctorId)
      .executeTakeFirst();
    if (!leave) throw AppError.notFound('Leave request');
    if (leave.status === 'APPLIED') throw AppError.conflict('This leave has already been applied.');

    const leaveStart = new Date(leave.starts_at);
    const leaveEnd = new Date(leave.ends_at);

    const conflicts = await this.conflictsFor(doctorId, leaveStart, leaveEnd);
    const byId = new Map(dto.dispositions.map((d) => [d.appointmentId, d]));

    const missing = conflicts.filter((c) => !byId.has(c.appointmentId));
    if (missing.length) {
      throw AppError.leaveConflict({
        message: 'Every affected appointment needs a disposition.',
        missing: missing.map((m) => m.appointmentId),
      });
    }

    const doctorRow = await this.db
      .selectFrom('doctor')
      .innerJoin('app_user', 'app_user.id', 'doctor.user_id')
      .select(['app_user.name as name', 'app_user.email as email'])
      .where('doctor.id', '=', doctorId)
      .executeTakeFirstOrThrow();

    const changes: string[] = [];
    const calendarOps: { appointmentId: string; action: 'DELETE' | 'CREATE' }[] = [];

    await this.db.transaction().execute(async (trx) => {
      await trx
        .updateTable('doctor_leave')
        .set({ status: 'APPLIED', applied_at: new Date() })
        .where('id', '=', leaveId)
        .execute();

      for (const conflict of conflicts) {
        const disposition = byId.get(conflict.appointmentId)!;
        const ctx = await this.contextFor(trx as any, conflict.appointmentId);
        const originalWhen = this.clock.dateTime(ctx.startsAt);

        // Every path starts by standing the old appointment down.
        await trx
          .updateTable('appointment')
          .set({
            state: 'CANCELLED',
            hold_expires_at: null,
            cancel_reason: `Doctor on leave: ${leave.reason ?? 'unspecified'}`,
            cancelled_by: user.id,
          })
          .where('id', '=', conflict.appointmentId)
          .execute();

        // Kill any queued reminder for the appointment we just stood down.
        await trx
          .updateTable('notification_outbox')
          .set({ state: 'DEAD', last_error: 'Appointment cancelled by doctor leave' })
          .where('dedupe_key', '=', `${conflict.appointmentId}:REMINDER_24H`)
          .where('state', '=', 'PENDING')
          .execute();

        calendarOps.push({ appointmentId: conflict.appointmentId, action: 'DELETE' });

        if (disposition.action === 'CANCEL') {
          await this.outbox.enqueue(trx, drafts.leaveRescheduled({
            appointmentId: conflict.appointmentId,
            patientEmail: ctx.patientEmail,
            patientName: ctx.patientName,
            doctorName: doctorRow.name,
            originalWhen,
            newWhen: null,
            leaveId,
          }));
          changes.push(`${ctx.patientName} — ${originalWhen} — cancelled`);
          continue;
        }

        // Rebook or reassign.
        const targetDoctorId =
          disposition.action === 'REASSIGN_DOCTOR' ? disposition.newDoctorId : doctorId;
        if (!targetDoctorId) {
          throw AppError.leaveConflict({
            appointmentId: conflict.appointmentId,
            message: 'REASSIGN_DOCTOR requires newDoctorId.',
          });
        }
        if (!disposition.newStartsAt) {
          throw AppError.leaveConflict({
            appointmentId: conflict.appointmentId,
            message: 'A replacement slot is required for this action.',
          });
        }

        const newStart = new Date(disposition.newStartsAt);
        // Validate against the target doctor's working hours. This read runs
        // outside the transaction's own writes, so the constraint below stays
        // the real arbiter.
        const { endsAt: newEnd } = await this.slots.resolveSlot(targetDoctorId, newStart).catch((e) => {
          throw AppError.leaveConflict({
            appointmentId: conflict.appointmentId,
            newStartsAt: disposition.newStartsAt,
            message: e?.response?.message ?? 'The replacement slot is not bookable.',
          });
        });

        let created;
        try {
          created = await trx
            .insertInto('appointment')
            .values({
              doctor_id: targetDoctorId,
              patient_id: ctx.patientId,
              starts_at: newStart,
              ends_at: newEnd,
              state: 'CONFIRMED',
              rescheduled_from_id: conflict.appointmentId,
            })
            .returning(['id'])
            .executeTakeFirstOrThrow();
        } catch (e) {
          if (pgCode(e) === PG.EXCLUSION_VIOLATION) {
            // Rolls the whole transaction back — see the method comment.
            throw AppError.leaveConflict({
              appointmentId: conflict.appointmentId,
              newStartsAt: disposition.newStartsAt,
              message: 'That replacement slot was taken. Nothing was applied; pick another and resubmit.',
            });
          }
          throw e;
        }

        await trx
          .updateTable('symptom_intake')
          .set({ appointment_id: created.id })
          .where('appointment_id', '=', conflict.appointmentId)
          .execute();

        const newDoctorName =
          disposition.action === 'REASSIGN_DOCTOR'
            ? (await trx
                .selectFrom('doctor')
                .innerJoin('app_user', 'app_user.id', 'doctor.user_id')
                .select('app_user.name as name')
                .where('doctor.id', '=', targetDoctorId)
                .executeTakeFirst())?.name ?? null
            : null;

        const newWhen = this.clock.dateTime(newStart);
        await this.outbox.enqueue(trx, drafts.leaveRescheduled({
          appointmentId: created.id,
          patientEmail: ctx.patientEmail,
          patientName: ctx.patientName,
          doctorName: doctorRow.name,
          originalWhen,
          newWhen,
          newDoctorName,
          leaveId,
        }));

        calendarOps.push({ appointmentId: created.id, action: 'CREATE' });
        changes.push(
          `${ctx.patientName} — ${originalWhen} → ${newWhen}${newDoctorName ? ` with ${newDoctorName}` : ''}`,
        );
      }

      // One consolidated email to the doctor rather than N.
      await this.outbox.enqueue(trx, drafts.leaveSummaryDoctor({
        leaveId,
        doctorEmail: doctorRow.email,
        doctorName: doctorRow.name,
        leaveFrom: this.clock.dateTime(leaveStart),
        leaveTo: this.clock.dateTime(leaveEnd),
        changes,
      }));
    });

    // Only after the transaction commits.
    for (const op of calendarOps) await this.queue.calendarSync(op);
    await this.queue.drainOutboxNow();

    await this.audit.record({
      actor: user, action: 'leave.resolve', entity: 'doctor_leave', entityId: leaveId,
      metadata: { handled: conflicts.length },
    });

    return { leaveId, status: 'APPLIED' as const, handled: conflicts.length, changes };
  }

  // --------------------------------------------------------------- reads ----

  async list(user: AuthUser, doctorId: string) {
    this.assertDoctorScope(user, doctorId);
    return this.db
      .selectFrom('doctor_leave').selectAll()
      .where('doctor_id', '=', doctorId)
      .orderBy('starts_at', 'desc').limit(50).execute();
  }

  async cancelProposed(user: AuthUser, doctorId: string, leaveId: string) {
    this.assertDoctorScope(user, doctorId);
    const res = await this.db
      .updateTable('doctor_leave')
      .set({ status: 'CANCELLED' })
      .where('id', '=', leaveId).where('doctor_id', '=', doctorId).where('status', '=', 'PROPOSED')
      .executeTakeFirst();
    if (Number(res.numUpdatedRows ?? 0) === 0) {
      throw AppError.conflict('Only a proposed leave can be withdrawn.');
    }
    return { leaveId, status: 'CANCELLED' as const };
  }

  private async contextFor(trx: Db, appointmentId: string) {
    const r = await trx
      .selectFrom('appointment')
      .innerJoin('patient', 'patient.id', 'appointment.patient_id')
      .innerJoin('app_user as pu', 'pu.id', 'patient.user_id')
      .select([
        'appointment.starts_at as startsAt',
        'appointment.patient_id as patientId',
        'pu.name as patientName',
        'pu.email as patientEmail',
      ])
      .where('appointment.id', '=', appointmentId)
      .executeTakeFirstOrThrow();
    return {
      startsAt: new Date(r.startsAt),
      patientId: r.patientId,
      patientName: r.patientName,
      patientEmail: r.patientEmail,
    };
  }

  /** A doctor may only manage their own leave; an admin may manage anyone's. */
  private assertDoctorScope(user: AuthUser, doctorId: string) {
    if (user.role === 'ADMIN') return;
    if (user.role === 'DOCTOR' && user.doctorId === doctorId) return;
    throw AppError.forbidden();
  }
}
