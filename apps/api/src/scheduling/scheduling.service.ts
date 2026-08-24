import { Inject, Injectable, Logger } from '@nestjs/common';
import { PG, pgCode, pgConstraint, type Db } from '@ham/db';
import type { Transaction } from 'kysely';
import type { Database } from '@ham/db';
import type { AppointmentDto, AuthUser } from '@ham/types';
import { DB } from '../db/db.module';
import { AppError } from '../common/errors/app-error';
import { ClockService } from '../common/clock.service';
import { AuditService } from '../common/audit.service';
import { OutboxService } from '../notifications/outbox.service';
import * as drafts from '../notifications/drafts';
import { QueueService } from '../queue/queue.service';
import { SlotsService } from './slots.service';
import { loadConfig } from '../config/env';
import { HoldDto, IntakeDto, CancelDto, RescheduleDto } from './dto';

@Injectable()
export class SchedulingService {
  private readonly logger = new Logger(SchedulingService.name);
  private readonly config = loadConfig();

  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly slots: SlotsService,
    private readonly clock: ClockService,
    private readonly outbox: OutboxService,
    private readonly queue: QueueService,
    private readonly audit: AuditService,
  ) {}

  // ---------------------------------------------------------------- hold ----

  /**
   * Places a short-lived HELD row on a slot.
   *
   * The hold exists because the patient must complete the symptom form before
   * confirming, and that takes minutes. Without it, two patients could both fill
   * in a form for the same 09:00 and one would be rejected after doing the work.
   *
   * There is deliberately no SELECT-then-INSERT check for collisions: the
   * exclusion constraint decides, inside the same lock as the write. A losing
   * racer gets 23P01, which becomes a clean 409.
   */
  async hold(user: AuthUser, dto: HoldDto, idempotencyKey?: string) {
    if (!user.patientId) throw AppError.forbidden('Only patients can book appointments.');

    const startsAt = new Date(dto.startsAt);
    if (Number.isNaN(startsAt.getTime())) throw AppError.slotUnavailable('Invalid start time.');

    const horizon = Date.now() + this.config.MAX_ADVANCE_BOOKING_DAYS * 86_400_000;
    if (startsAt.getTime() > horizon) {
      throw AppError.slotUnavailable(
        `Bookings open ${this.config.MAX_ADVANCE_BOOKING_DAYS} days ahead.`,
      );
    }

    // A retried request must return the original hold rather than racing
    // itself. The exclusion constraint raises 23P01 before the idempotency
    // index raises 23505, so the key is resolved up front as well as in the
    // catch below.
    if (idempotencyKey) {
      const prior = await this.db
        .selectFrom('appointment').selectAll()
        .where('idempotency_key', '=', idempotencyKey)
        .executeTakeFirst();
      if (prior) {
        return {
          appointmentId: prior.id,
          startsAt: prior.starts_at,
          endsAt: prior.ends_at,
          holdExpiresAt: prior.hold_expires_at,
          expiresInSeconds: this.config.SLOT_HOLD_TTL_MINUTES * 60,
          idempotentReplay: true,
        };
      }
    }

    const { endsAt } = await this.slots.resolveSlot(dto.doctorId, startsAt);
    const holdExpiresAt = new Date(Date.now() + this.config.SLOT_HOLD_TTL_MINUTES * 60_000);

    try {
      const row = await this.db
        .insertInto('appointment')
        .values({
          doctor_id: dto.doctorId,
          patient_id: user.patientId,
          starts_at: startsAt,
          ends_at: endsAt,
          state: 'HELD',
          hold_expires_at: holdExpiresAt,
          idempotency_key: idempotencyKey ?? null,
        })
        .returningAll()
        .executeTakeFirstOrThrow();

      await this.audit.record({
        actor: user,
        action: 'appointment.hold',
        entity: 'appointment',
        entityId: row.id,
        metadata: { doctorId: dto.doctorId, startsAt: startsAt.toISOString() },
      });

      // Deliberately emits nothing. A hold is not a booking: no email, no
      // calendar event, nothing the patient could mistake for a confirmation.
      return {
        appointmentId: row.id,
        startsAt: row.starts_at,
        endsAt: row.ends_at,
        holdExpiresAt: row.hold_expires_at,
        expiresInSeconds: this.config.SLOT_HOLD_TTL_MINUTES * 60,
      };
    } catch (e) {
      if (pgCode(e) === PG.UNIQUE_VIOLATION && pgConstraint(e)?.includes('idempotency')) {
        // A retried request with the same key returns the original hold.
        const existing = await this.db
          .selectFrom('appointment')
          .selectAll()
          .where('idempotency_key', '=', idempotencyKey!)
          .executeTakeFirstOrThrow();
        return {
          appointmentId: existing.id,
          startsAt: existing.starts_at,
          endsAt: existing.ends_at,
          holdExpiresAt: existing.hold_expires_at,
          expiresInSeconds: this.config.SLOT_HOLD_TTL_MINUTES * 60,
          idempotentReplay: true,
        };
      }
      if (pgCode(e) === PG.EXCLUSION_VIOLATION) {
        if (idempotencyKey) {
          const prior = await this.db
            .selectFrom('appointment').selectAll()
            .where('idempotency_key', '=', idempotencyKey)
            .executeTakeFirst();
          if (prior) {
            return {
              appointmentId: prior.id,
              startsAt: prior.starts_at,
              endsAt: prior.ends_at,
              holdExpiresAt: prior.hold_expires_at,
              expiresInSeconds: this.config.SLOT_HOLD_TTL_MINUTES * 60,
              idempotentReplay: true,
            };
          }
        }
        if (pgConstraint(e) === 'no_patient_overlap') throw AppError.patientDoubleBooked();
        throw AppError.slotTaken();
      }
      throw e;
    }
  }

  // -------------------------------------------------------------- intake ----

  async submitIntake(user: AuthUser, appointmentId: string, dto: IntakeDto) {
    const appt = await this.mustOwnAsPatient(user, appointmentId);
    if (!['HELD', 'CONFIRMED'].includes(appt.state)) {
      throw AppError.conflict('This appointment is no longer open for intake.');
    }

    await this.db
      .insertInto('symptom_intake')
      .values({
        appointment_id: appointmentId,
        symptoms_text: dto.symptomsText,
        duration_days: dto.durationDays ?? null,
        severity: dto.severity ?? null,
        existing_meds: dto.existingMeds ?? null,
        allergies: dto.allergies ?? null,
      })
      .onConflict((oc) =>
        oc.column('appointment_id').doUpdateSet({
          symptoms_text: dto.symptomsText,
          duration_days: dto.durationDays ?? null,
          severity: dto.severity ?? null,
          existing_meds: dto.existingMeds ?? null,
          allergies: dto.allergies ?? null,
          submitted_at: new Date(),
        }),
      )
      .execute();

    await this.audit.record({
      actor: user, action: 'intake.submit', entity: 'appointment', entityId: appointmentId,
    });
    return { ok: true };
  }

  // ------------------------------------------------------------- confirm ----

  /**
   * Turns a live hold into a confirmed appointment.
   *
   * The UPDATE is guarded on state='HELD' AND hold_expires_at > now(), so an
   * expired hold affects zero rows and returns 410 — no read-then-write race,
   * and no dependence on the sweeper having already run.
   *
   * The outbox rows are written in the SAME transaction as the state change.
   * That is the whole reliability argument: an appointment cannot exist without
   * its confirmation email also existing as committed intent.
   */
  async confirm(user: AuthUser, appointmentId: string) {
    const appt = await this.mustOwnAsPatient(user, appointmentId);
    if (appt.state === 'CONFIRMED') return this.toDto(appointmentId); // idempotent

    const intake = await this.db
      .selectFrom('symptom_intake')
      .select('id')
      .where('appointment_id', '=', appointmentId)
      .executeTakeFirst();
    if (!intake) throw AppError.intakeRequired();

    const ctx = await this.contextFor(appointmentId);

    await this.db.transaction().execute(async (trx) => {
      const res = await trx
        .updateTable('appointment')
        .set({ state: 'CONFIRMED', hold_expires_at: null })
        .where('id', '=', appointmentId)
        .where('state', '=', 'HELD')
        .where('hold_expires_at', '>', new Date())
        .executeTakeFirst();

      if (Number(res.numUpdatedRows ?? 0) === 0) throw AppError.holdExpired();

      const when = this.clock.dateTime(ctx.startsAt);
      const reminderAt = new Date(
        ctx.startsAt.getTime() - this.config.REMINDER_HOURS_BEFORE * 3600_000,
      );
      const reminder = drafts.reminder24h(ctx, when, reminderAt);

      await this.outbox.enqueue(trx, [
        ...drafts.bookingConfirmed(ctx, when),
        ...(reminder ? [reminder] : []),
      ]);
    });

    // After commit only. A queue outage cannot roll back a confirmed booking.
    await this.queue.preVisitSummary(appointmentId);
    await this.queue.calendarSync({ appointmentId, action: 'CREATE' });
    await this.queue.drainOutboxNow();

    await this.audit.record({
      actor: user, action: 'appointment.confirm', entity: 'appointment', entityId: appointmentId,
    });
    return this.toDto(appointmentId);
  }

  // -------------------------------------------------------------- cancel ----

  async cancel(user: AuthUser, appointmentId: string, dto: CancelDto) {
    const appt = await this.loadForActor(user, appointmentId);
    if (!['HELD', 'CONFIRMED'].includes(appt.state)) {
      throw AppError.conflict('This appointment is not active.');
    }

    const wasConfirmed = appt.state === 'CONFIRMED';
    const ctx = await this.contextFor(appointmentId);

    await this.db.transaction().execute(async (trx) => {
      const res = await trx
        .updateTable('appointment')
        .set({
          state: 'CANCELLED',
          hold_expires_at: null,
          cancel_reason: dto.reason ?? null,
          cancelled_by: user.id,
        })
        .where('id', '=', appointmentId)
        .where('state', 'in', ['HELD', 'CONFIRMED'])
        .executeTakeFirst();
      if (Number(res.numUpdatedRows ?? 0) === 0) throw AppError.conflict('This appointment is not active.');

      // Only tell people about something they were told about in the first
      // place. Cancelling a silent hold should stay silent.
      if (wasConfirmed) {
        await this.outbox.enqueue(trx, drafts.cancelled(ctx, this.clock.dateTime(ctx.startsAt), dto.reason));
      }

      // A reminder for a cancelled appointment must never go out.
      await trx
        .updateTable('notification_outbox')
        .set({ state: 'DEAD', last_error: 'Appointment cancelled before send' })
        .where('dedupe_key', '=', `${appointmentId}:REMINDER_24H`)
        .where('state', '=', 'PENDING')
        .execute();
    });

    if (wasConfirmed) {
      await this.queue.calendarSync({ appointmentId, action: 'DELETE' });
      await this.queue.drainOutboxNow();
    }

    await this.audit.record({
      actor: user, action: 'appointment.cancel', entity: 'appointment', entityId: appointmentId,
      metadata: { reason: dto.reason ?? null },
    });
    return this.toDto(appointmentId);
  }

  // ---------------------------------------------------------- reschedule ----

  /**
   * Modelled as cancel-and-rebook linked by rescheduled_from_id, so the audit
   * trail keeps both times. The new row obeys the same exclusion constraint, so
   * a reschedule can legitimately lose a race and return 409.
   */
  async reschedule(user: AuthUser, appointmentId: string, dto: RescheduleDto) {
    const appt = await this.loadForActor(user, appointmentId);
    if (appt.state !== 'CONFIRMED') throw AppError.conflict('Only a confirmed appointment can be moved.');

    const startsAt = new Date(dto.startsAt);
    const { endsAt } = await this.slots.resolveSlot(appt.doctor_id, startsAt);
    const oldCtx = await this.contextFor(appointmentId);

    const newId = await this.db.transaction().execute(async (trx) => {
      await trx
        .updateTable('appointment')
        .set({ state: 'CANCELLED', cancel_reason: 'Rescheduled', cancelled_by: user.id, hold_expires_at: null })
        .where('id', '=', appointmentId)
        .where('state', '=', 'CONFIRMED')
        .execute();

      let created;
      try {
        created = await trx
          .insertInto('appointment')
          .values({
            doctor_id: appt.doctor_id,
            patient_id: appt.patient_id,
            starts_at: startsAt,
            ends_at: endsAt,
            state: 'CONFIRMED',
            rescheduled_from_id: appointmentId,
          })
          .returning(['id'])
          .executeTakeFirstOrThrow();
      } catch (e) {
        if (pgCode(e) === PG.EXCLUSION_VIOLATION) throw AppError.slotTaken();
        throw e;
      }

      // Carry the clinical record across so the doctor keeps the intake.
      await trx
        .updateTable('symptom_intake')
        .set({ appointment_id: created.id })
        .where('appointment_id', '=', appointmentId)
        .execute();

      const when = this.clock.dateTime(startsAt);
      const newCtx = { ...oldCtx, appointmentId: created.id, startsAt };
      const reminderAt = new Date(startsAt.getTime() - this.config.REMINDER_HOURS_BEFORE * 3600_000);
      const reminder = drafts.reminder24h(newCtx, when, reminderAt);

      await this.outbox.enqueue(trx, [
        drafts.leaveRescheduled({
          appointmentId: created.id,
          patientEmail: oldCtx.patientEmail,
          patientName: oldCtx.patientName,
          doctorName: oldCtx.doctorName,
          originalWhen: this.clock.dateTime(oldCtx.startsAt),
          newWhen: when,
          leaveId: 'self-reschedule',
        }),
        ...(reminder ? [reminder] : []),
      ]);

      await trx
        .updateTable('notification_outbox')
        .set({ state: 'DEAD', last_error: 'Appointment rescheduled before send' })
        .where('dedupe_key', '=', `${appointmentId}:REMINDER_24H`)
        .where('state', '=', 'PENDING')
        .execute();

      return created.id;
    });

    await this.queue.calendarSync({ appointmentId, action: 'DELETE' });
    await this.queue.calendarSync({ appointmentId: newId, action: 'CREATE' });
    await this.queue.drainOutboxNow();

    await this.audit.record({
      actor: user, action: 'appointment.reschedule', entity: 'appointment', entityId: appointmentId,
      metadata: { newAppointmentId: newId, startsAt: startsAt.toISOString() },
    });
    return this.toDto(newId);
  }

  // --------------------------------------------------------------- reads ----

  async listForPatient(user: AuthUser): Promise<AppointmentDto[]> {
    if (!user.patientId) throw AppError.forbidden('Only patients have a booking list.');
    return this.listWhere((qb) => qb.where('appointment.patient_id', '=', user.patientId!));
  }

  async listForDoctor(user: AuthUser, date?: string): Promise<AppointmentDto[]> {
    if (!user.doctorId) throw AppError.forbidden('Only doctors have a schedule.');
    return this.listWhere((qb) => {
      let q = qb.where('appointment.doctor_id', '=', user.doctorId!);
      if (date) {
        const start = new Date(
          new Date(`${date}T00:00:00Z`).getTime() - this.clock.offsetMinutes * 60_000,
        );
        q = q.where('appointment.starts_at', '>=', start)
             .where('appointment.starts_at', '<', new Date(start.getTime() + 86_400_000));
      }
      return q;
    });
  }

  async getOne(user: AuthUser, appointmentId: string): Promise<AppointmentDto> {
    await this.loadForActor(user, appointmentId);
    return this.toDto(appointmentId);
  }

  // ------------------------------------------------------------ internals ---

  private listWhere(apply: (qb: any) => any): Promise<AppointmentDto[]> {
    const base = this.db
      .selectFrom('appointment')
      .innerJoin('doctor', 'doctor.id', 'appointment.doctor_id')
      .innerJoin('app_user as du', 'du.id', 'doctor.user_id')
      .innerJoin('patient', 'patient.id', 'appointment.patient_id')
      .innerJoin('app_user as pu', 'pu.id', 'patient.user_id')
      .leftJoin('symptom_intake', 'symptom_intake.appointment_id', 'appointment.id')
      .leftJoin('visit_note', 'visit_note.appointment_id', 'appointment.id')
      .select([
        'appointment.id as id',
        'appointment.doctor_id as doctorId',
        'appointment.patient_id as patientId',
        'appointment.starts_at as startsAt',
        'appointment.ends_at as endsAt',
        'appointment.state as state',
        'appointment.hold_expires_at as holdExpiresAt',
        'appointment.cancel_reason as cancelReason',
        'appointment.gcal_patient_event_id as gcalPatient',
        'appointment.gcal_doctor_event_id as gcalDoctor',
        'du.name as doctorName',
        'doctor.specialisation as specialisation',
        'pu.name as patientName',
        'symptom_intake.id as intakeId',
        'visit_note.id as visitNoteId',
      ])
      .orderBy('appointment.starts_at', 'desc');

    return apply(base)
      .execute()
      .then((rows: any[]) =>
        rows.map((r) => ({
          id: r.id,
          doctorId: r.doctorId,
          doctorName: r.doctorName,
          specialisation: r.specialisation,
          patientId: r.patientId,
          patientName: r.patientName,
          startsAt: new Date(r.startsAt).toISOString(),
          endsAt: new Date(r.endsAt).toISOString(),
          state: r.state,
          holdExpiresAt: r.holdExpiresAt ? new Date(r.holdExpiresAt).toISOString() : null,
          cancelReason: r.cancelReason,
          hasIntake: Boolean(r.intakeId),
          hasVisitNote: Boolean(r.visitNoteId),
          calendarSynced: Boolean(r.gcalPatient || r.gcalDoctor),
        })),
      );
  }

  private async toDto(appointmentId: string): Promise<AppointmentDto> {
    const [row] = await this.listWhere((qb: any) => qb.where('appointment.id', '=', appointmentId));
    if (!row) throw AppError.notFound('Appointment');
    return row;
  }

  /** Denormalised context for email rendering. */
  async contextFor(appointmentId: string): Promise<drafts.AppointmentContext> {
    const r = await this.db
      .selectFrom('appointment')
      .innerJoin('doctor', 'doctor.id', 'appointment.doctor_id')
      .innerJoin('app_user as du', 'du.id', 'doctor.user_id')
      .innerJoin('patient', 'patient.id', 'appointment.patient_id')
      .innerJoin('app_user as pu', 'pu.id', 'patient.user_id')
      .select([
        'appointment.id as id',
        'appointment.starts_at as startsAt',
        'du.name as doctorName',
        'du.email as doctorEmail',
        'doctor.specialisation as specialisation',
        'pu.name as patientName',
        'pu.email as patientEmail',
      ])
      .where('appointment.id', '=', appointmentId)
      .executeTakeFirst();
    if (!r) throw AppError.notFound('Appointment');
    return {
      appointmentId: r.id,
      startsAt: new Date(r.startsAt),
      doctorName: r.doctorName,
      doctorEmail: r.doctorEmail,
      specialisation: r.specialisation,
      patientName: r.patientName,
      patientEmail: r.patientEmail,
    };
  }

  private async mustOwnAsPatient(user: AuthUser, appointmentId: string) {
    const appt = await this.db
      .selectFrom('appointment').selectAll().where('id', '=', appointmentId).executeTakeFirst();
    if (!appt) throw AppError.notFound('Appointment');
    if (user.role === 'ADMIN') return appt;
    if (appt.patient_id !== user.patientId) throw AppError.forbidden();
    return appt;
  }

  /** Ownership is checked here, in the service, against the row — never in a guard. */
  private async loadForActor(user: AuthUser, appointmentId: string) {
    const appt = await this.db
      .selectFrom('appointment').selectAll().where('id', '=', appointmentId).executeTakeFirst();
    if (!appt) throw AppError.notFound('Appointment');
    if (user.role === 'ADMIN') return appt;
    if (user.role === 'PATIENT' && appt.patient_id === user.patientId) return appt;
    if (user.role === 'DOCTOR' && appt.doctor_id === user.doctorId) return appt;
    throw AppError.forbidden();
  }
}
