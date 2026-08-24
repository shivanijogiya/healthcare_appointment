import { Inject, Injectable, Logger } from '@nestjs/common';
import type { Db } from '@ham/db';
import type { AuthUser } from '@ham/types';
import { DB } from '../db/db.module';
import { AppError } from '../common/errors/app-error';
import { ClockService } from '../common/clock.service';
import { AuditService } from '../common/audit.service';
import { QueueService } from '../queue/queue.service';
import { OutboxService } from '../notifications/outbox.service';
import * as drafts from '../notifications/drafts';
import { expandDoseTimes } from './medication-schedule';
import { loadConfig } from '../config/env';
import { VisitNoteDto } from './dto';

@Injectable()
export class VisitsService {
  private readonly logger = new Logger(VisitsService.name);
  private readonly config = loadConfig();

  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly clock: ClockService,
    private readonly queue: QueueService,
    private readonly outbox: OutboxService,
    private readonly audit: AuditService,
  ) {}

  /**
   * Records the visit and marks the appointment COMPLETED.
   *
   * The LLM summary and the medication fan-out are both queued after commit.
   * A doctor's notes must be saved whether or not a model is reachable — losing
   * clinical text because a summariser is down would be indefensible.
   */
  async submitNote(user: AuthUser, appointmentId: string, dto: VisitNoteDto) {
    if (!user.doctorId && user.role !== 'ADMIN') {
      throw AppError.forbidden('Only the treating doctor can file visit notes.');
    }

    const appt = await this.db
      .selectFrom('appointment').selectAll().where('id', '=', appointmentId).executeTakeFirst();
    if (!appt) throw AppError.notFound('Appointment');
    if (user.role === 'DOCTOR' && appt.doctor_id !== user.doctorId) throw AppError.forbidden();
    if (!['CONFIRMED', 'COMPLETED'].includes(appt.state)) {
      throw AppError.conflict('Notes can only be filed against a confirmed appointment.');
    }

    const existing = await this.db
      .selectFrom('visit_note').select('id')
      .where('appointment_id', '=', appointmentId).executeTakeFirst();
    if (existing) throw AppError.conflict('Notes have already been filed for this visit.');

    const visitNoteId = await this.db.transaction().execute(async (trx) => {
      const note = await trx
        .insertInto('visit_note')
        .values({
          appointment_id: appointmentId,
          doctor_id: appt.doctor_id,
          clinical_notes: dto.clinicalNotes,
          diagnosis: dto.diagnosis ?? null,
          follow_up_date: dto.followUpDate ?? null,
        })
        .returning(['id'])
        .executeTakeFirstOrThrow();

      if (dto.prescriptions?.length) {
        await trx
          .insertInto('prescription')
          .values(dto.prescriptions.map((p) => ({
            visit_note_id: note.id,
            drug_name: p.drugName,
            dosage: p.dosage,
            frequency: p.frequency,
            duration_days: p.durationDays,
            instructions: p.instructions ?? null,
          })))
          .execute();
      }

      await trx
        .updateTable('appointment')
        .set({ state: 'COMPLETED' })
        .where('id', '=', appointmentId)
        .execute();

      return note.id;
    });

    await this.queue.medicationFanout(visitNoteId);
    await this.queue.postVisitSummary(visitNoteId);

    await this.audit.record({
      actor: user, action: 'visit.note.submit', entity: 'visit_note', entityId: visitNoteId,
      metadata: { appointmentId, prescriptions: dto.prescriptions?.length ?? 0 },
    });

    return { visitNoteId, appointmentId, state: 'COMPLETED' as const };
  }

  /**
   * Expands each prescription's frequency and duration into concrete reminder
   * rows. Doing this once, at write time, means the recurring reminder job is a
   * trivial "fire what is due" query rather than a schedule interpreter.
   */
  async fanOutMedicationReminders(visitNoteId: string): Promise<number> {
    const note = await this.db
      .selectFrom('visit_note')
      .innerJoin('appointment', 'appointment.id', 'visit_note.appointment_id')
      .select(['visit_note.id as id', 'appointment.patient_id as patientId'])
      .where('visit_note.id', '=', visitNoteId)
      .executeTakeFirst();
    if (!note) return 0;

    const prescriptions = await this.db
      .selectFrom('prescription').selectAll().where('visit_note_id', '=', visitNoteId).execute();

    const rows: { prescription_id: string; patient_id: string; fire_at: Date }[] = [];
    for (const p of prescriptions) {
      const times = expandDoseTimes({
        frequency: p.frequency,
        durationDays: p.duration_days,
        from: new Date(),
        offsetMinutes: this.clock.offsetMinutes,
        maxDays: this.config.MEDICATION_REMINDER_MAX_DAYS,
      });
      for (const at of times) {
        rows.push({ prescription_id: p.id, patient_id: note.patientId, fire_at: at });
      }
    }
    if (!rows.length) return 0;

    // The (prescription_id, fire_at) unique constraint makes a replayed job a
    // no-op instead of a duplicate reminder storm.
    await this.db
      .insertInto('medication_reminder')
      .values(rows)
      .onConflict((oc) => oc.columns(['prescription_id', 'fire_at']).doNothing())
      .execute();

    this.logger.log(`Scheduled ${rows.length} medication reminder(s) for visit ${visitNoteId}`);
    return rows.length;
  }

  /** Fires every due reminder as an outbox row. Driven by a repeatable job. */
  async dispatchDueMedicationReminders(limit = 200): Promise<number> {
    const due = await this.db
      .selectFrom('medication_reminder')
      .innerJoin('prescription', 'prescription.id', 'medication_reminder.prescription_id')
      .innerJoin('visit_note', 'visit_note.id', 'prescription.visit_note_id')
      .innerJoin('doctor', 'doctor.id', 'visit_note.doctor_id')
      .innerJoin('app_user as du', 'du.id', 'doctor.user_id')
      .innerJoin('patient', 'patient.id', 'medication_reminder.patient_id')
      .innerJoin('app_user as pu', 'pu.id', 'patient.user_id')
      .select([
        'medication_reminder.id as id',
        'medication_reminder.fire_at as fireAt',
        'prescription.drug_name as drugName',
        'prescription.dosage as dosage',
        'prescription.instructions as instructions',
        'prescription.duration_days as durationDays',
        'du.name as doctorName',
        'pu.name as patientName',
        'pu.email as patientEmail',
      ])
      .where('medication_reminder.sent', '=', false)
      .where('medication_reminder.fire_at', '<=', new Date())
      // A dose whose time passed long ago is stale; taking it late on our say-so
      // would be wrong, so it is marked sent without an email.
      .where('medication_reminder.fire_at', '>', new Date(Date.now() - 2 * 3600_000))
      .orderBy('medication_reminder.fire_at')
      .limit(limit)
      .execute();

    // Retire anything stale in one statement.
    await this.db
      .updateTable('medication_reminder')
      .set({ sent: true })
      .where('sent', '=', false)
      .where('fire_at', '<=', new Date(Date.now() - 2 * 3600_000))
      .execute();

    if (!due.length) return 0;

    await this.db.transaction().execute(async (trx) => {
      await this.outbox.enqueue(trx, due.map((r) => drafts.medicationReminder({
        reminderId: r.id,
        patientEmail: r.patientEmail,
        patientName: r.patientName,
        drugName: r.drugName,
        dosage: r.dosage,
        instructions: r.instructions,
        doctorName: r.doctorName,
        courseEnds: `${r.durationDays} day course`,
      })));

      await trx
        .updateTable('medication_reminder')
        .set({ sent: true })
        .where('id', 'in', due.map((r) => r.id))
        .execute();
    });

    return due.length;
  }

  async noteForAppointment(user: AuthUser, appointmentId: string) {
    const appt = await this.db
      .selectFrom('appointment').selectAll().where('id', '=', appointmentId).executeTakeFirst();
    if (!appt) throw AppError.notFound('Appointment');
    if (user.role === 'DOCTOR' && appt.doctor_id !== user.doctorId) throw AppError.forbidden();
    if (user.role === 'PATIENT' && appt.patient_id !== user.patientId) throw AppError.forbidden();

    const note = await this.db
      .selectFrom('visit_note').selectAll()
      .where('appointment_id', '=', appointmentId).executeTakeFirst();
    if (!note) return null;

    const prescriptions = await this.db
      .selectFrom('prescription').selectAll().where('visit_note_id', '=', note.id).execute();

    return {
      id: note.id,
      clinicalNotes: note.clinical_notes,
      diagnosis: note.diagnosis,
      followUpDate: note.follow_up_date ? new Date(note.follow_up_date).toISOString().slice(0, 10) : null,
      submittedAt: new Date(note.submitted_at).toISOString(),
      prescriptions: prescriptions.map((p) => ({
        id: p.id,
        drugName: p.drug_name,
        dosage: p.dosage,
        frequency: p.frequency,
        durationDays: p.duration_days,
        instructions: p.instructions,
      })),
    };
  }
}
