import { Inject, Injectable, Logger } from '@nestjs/common';
import type { Db } from '@ham/db';
import type { PostVisitSummaryDto, PreVisitSummaryDto } from '@ham/types';
import { DB } from '../db/db.module';
import { AppError } from '../common/errors/app-error';
import { ClockService } from '../common/clock.service';
import { OutboxService } from '../notifications/outbox.service';
import * as drafts from '../notifications/drafts';
import { LlmService, LlmUnavailableError } from './llm.service';
import { postVisitSchema, preVisitSchema, toUrgencyEnum } from './schemas';
import {
  PROMPT_VERSION,
  PRE_VISIT_SYSTEM,
  POST_VISIT_SYSTEM,
  preVisitUserPrompt,
  postVisitUserPrompt,
} from './prompts/v1';
import { describePrescription } from '../visits/medication-schedule';

/**
 * Owns both summaries: building the prompt, persisting the result, and — the
 * part that actually matters — deciding what the product does when the model
 * does not answer.
 */
@Injectable()
export class SummaryService {
  private readonly logger = new Logger(SummaryService.name);

  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly llm: LlmService,
    private readonly clock: ClockService,
    private readonly outbox: OutboxService,
  ) {}

  // ----------------------------------------------------------- pre-visit ----

  /**
   * Runs on the queue after an appointment is confirmed. Every exit path leaves
   * a pre_visit_summary row behind, because "we tried and failed" is information
   * the doctor's screen needs, whereas a missing row is ambiguous.
   */
  async generatePreVisit(appointmentId: string): Promise<'SUCCESS' | 'FAILED' | 'SKIPPED'> {
    const intake = await this.db
      .selectFrom('symptom_intake')
      .innerJoin('appointment', 'appointment.id', 'symptom_intake.appointment_id')
      .innerJoin('patient', 'patient.id', 'appointment.patient_id')
      .select([
        'symptom_intake.symptoms_text as symptoms',
        'symptom_intake.duration_days as durationDays',
        'symptom_intake.severity as severity',
        'symptom_intake.existing_meds as existingMeds',
        'symptom_intake.allergies as allergies',
        'patient.date_of_birth as dob',
        'patient.gender as gender',
        'appointment.state as state',
      ])
      .where('symptom_intake.appointment_id', '=', appointmentId)
      .executeTakeFirst();

    if (!intake) {
      await this.upsertPreVisit(appointmentId, {
        status: 'SKIPPED',
        error_message: 'No symptom intake was submitted.',
      });
      return 'SKIPPED';
    }

    await this.upsertPreVisit(appointmentId, { status: 'PENDING' });

    const age = intake.dob
      ? Math.floor((Date.now() - new Date(intake.dob).getTime()) / (365.25 * 86_400_000))
      : null;

    try {
      const result = await this.llm.generate(
        {
          system: PRE_VISIT_SYSTEM,
          user: preVisitUserPrompt({
            symptoms: intake.symptoms,
            durationDays: intake.durationDays,
            severity: intake.severity,
            existingMeds: intake.existingMeds,
            allergies: intake.allergies,
            patientAge: age,
            gender: intake.gender,
          }),
          maxTokens: 700,
          temperature: 0,
        },
        preVisitSchema,
      );

      await this.upsertPreVisit(appointmentId, {
        status: 'SUCCESS',
        urgency: toUrgencyEnum(result.value.urgency),
        chief_complaint: result.value.chief_complaint,
        questions: result.value.questions,
        raw_response: result.raw.slice(0, 8000),
        model: result.model,
        latency_ms: result.latencyMs,
        attempts: result.attempts,
        error_message: null,
      });
      return 'SUCCESS';
    } catch (err) {
      const message = err instanceof LlmUnavailableError ? err.message : (err as Error).message;
      await this.upsertPreVisit(appointmentId, {
        status: 'FAILED',
        error_message: message.slice(0, 400),
        attempts: err instanceof LlmUnavailableError ? err.attempts : 1,
      });
      this.logger.warn(`Pre-visit summary failed for ${appointmentId}: ${message}`);
      // Swallowed on purpose. The appointment is confirmed and the doctor will
      // see the raw intake instead; this is a degraded view, not an incident.
      return 'FAILED';
    }
  }

  private async upsertPreVisit(appointmentId: string, patch: Record<string, unknown>) {
    await this.db
      .insertInto('pre_visit_summary')
      .values({
        appointment_id: appointmentId,
        prompt_version: PROMPT_VERSION,
        status: 'PENDING',
        ...(patch as any),
      })
      .onConflict((oc) =>
        oc.column('appointment_id').doUpdateSet({
          prompt_version: PROMPT_VERSION,
          ...(patch as any),
        }),
      )
      .execute();
  }

  /**
   * What the doctor's workspace reads. When the summary failed, the raw intake
   * is returned alongside so the UI can show the symptoms verbatim rather than
   * an empty panel.
   */
  async preVisitFor(appointmentId: string): Promise<{
    summary: PreVisitSummaryDto | null;
    intake: Record<string, unknown> | null;
  }> {
    const [summary, intake] = await Promise.all([
      this.db
        .selectFrom('pre_visit_summary').selectAll()
        .where('appointment_id', '=', appointmentId).executeTakeFirst(),
      this.db
        .selectFrom('symptom_intake').selectAll()
        .where('appointment_id', '=', appointmentId).executeTakeFirst(),
    ]);

    return {
      summary: summary
        ? {
            status: summary.status,
            urgency: summary.urgency,
            chiefComplaint: summary.chief_complaint,
            questions: summary.questions ?? [],
            errorMessage: summary.error_message,
            model: summary.model,
            promptVersion: summary.prompt_version,
            generatedAt: summary.updated_at ? new Date(summary.updated_at).toISOString() : null,
          }
        : null,
      intake: intake
        ? {
            symptomsText: intake.symptoms_text,
            durationDays: intake.duration_days,
            severity: intake.severity,
            existingMeds: intake.existing_meds,
            allergies: intake.allergies,
            submittedAt: new Date(intake.submitted_at).toISOString(),
          }
        : null,
    };
  }

  // ---------------------------------------------------------- post-visit ----

  /**
   * Runs after a doctor submits notes. On failure the patient still receives a
   * complete medication plan, rendered directly from the prescription rows —
   * the model makes the email friendlier, it is not the source of the clinical
   * content.
   */
  async generatePostVisit(visitNoteId: string): Promise<'SUCCESS' | 'FAILED'> {
    const note = await this.db
      .selectFrom('visit_note')
      .innerJoin('appointment', 'appointment.id', 'visit_note.appointment_id')
      .innerJoin('patient', 'patient.id', 'appointment.patient_id')
      .innerJoin('app_user as pu', 'pu.id', 'patient.user_id')
      .innerJoin('doctor', 'doctor.id', 'visit_note.doctor_id')
      .innerJoin('app_user as du', 'du.id', 'doctor.user_id')
      .select([
        'visit_note.id as id',
        'visit_note.clinical_notes as notes',
        'visit_note.diagnosis as diagnosis',
        'visit_note.follow_up_date as followUpDate',
        'pu.name as patientName',
        'pu.email as patientEmail',
        'du.name as doctorName',
      ])
      .where('visit_note.id', '=', visitNoteId)
      .executeTakeFirst();
    if (!note) throw AppError.notFound('Visit note');

    const prescriptions = await this.db
      .selectFrom('prescription').selectAll()
      .where('visit_note_id', '=', visitNoteId).execute();

    const meds = prescriptions.map((p) => ({
      drugName: p.drug_name,
      dosage: p.dosage,
      frequency: p.frequency,
      durationDays: p.duration_days,
      instructions: p.instructions,
    }));

    const followUpDate = note.followUpDate ? this.clock.date(new Date(note.followUpDate)) : null;

    await this.upsertPostVisit(visitNoteId, { status: 'PENDING' });

    try {
      const result = await this.llm.generate(
        {
          system: POST_VISIT_SYSTEM,
          user: postVisitUserPrompt({
            notes: note.notes,
            diagnosis: note.diagnosis,
            prescriptions: meds,
            followUpDate,
          }),
          maxTokens: 900,
          temperature: 0.2,
        },
        postVisitSchema,
      );

      await this.upsertPostVisit(visitNoteId, {
        status: 'SUCCESS',
        summary_text: result.value.summary,
        med_schedule: JSON.stringify(result.value.medication_schedule),
        follow_up_steps: result.value.follow_up_steps,
        raw_response: result.raw.slice(0, 8000),
        model: result.model,
        latency_ms: result.latencyMs,
        attempts: result.attempts,
        error_message: null,
      });

      await this.outbox.enqueue(this.db, drafts.postVisitSummary({
        visitNoteId,
        patientEmail: note.patientEmail,
        patientName: note.patientName,
        summaryText: result.value.summary,
        medications: result.value.medication_schedule.map(
          (m) => `${m.drug} — ${m.when} (${m.duration})`,
        ),
        followUpSteps: result.value.follow_up_steps,
        followUpDate,
        degraded: false,
      }));
      return 'SUCCESS';
    } catch (err) {
      const message = err instanceof LlmUnavailableError ? err.message : (err as Error).message;
      await this.upsertPostVisit(visitNoteId, {
        status: 'FAILED',
        error_message: message.slice(0, 400),
        attempts: err instanceof LlmUnavailableError ? err.attempts : 1,
      });

      // Degraded, never absent: build the email from the prescription rows.
      await this.outbox.enqueue(this.db, drafts.postVisitSummary({
        visitNoteId,
        patientEmail: note.patientEmail,
        patientName: note.patientName,
        summaryText: note.diagnosis ? `Diagnosis recorded: ${note.diagnosis}.` : null,
        medications: meds.map(describePrescription),
        followUpSteps: followUpDate ? [`Return for a follow-up on ${followUpDate}.`] : [],
        followUpDate,
        degraded: true,
      }));

      this.logger.warn(`Post-visit summary failed for ${visitNoteId}; sent prescription fallback.`);
      return 'FAILED';
    }
  }

  private async upsertPostVisit(visitNoteId: string, patch: Record<string, unknown>) {
    await this.db
      .insertInto('post_visit_summary')
      .values({
        visit_note_id: visitNoteId,
        prompt_version: PROMPT_VERSION,
        status: 'PENDING',
        ...(patch as any),
      })
      .onConflict((oc) =>
        oc.column('visit_note_id').doUpdateSet({
          prompt_version: PROMPT_VERSION,
          ...(patch as any),
        }),
      )
      .execute();
  }

  /** What the patient portal reads, with the same degraded fallback as the email. */
  async postVisitForAppointment(appointmentId: string): Promise<PostVisitSummaryDto | null> {
    const note = await this.db
      .selectFrom('visit_note')
      .select(['id', 'diagnosis', 'follow_up_date as followUpDate'])
      .where('appointment_id', '=', appointmentId)
      .executeTakeFirst();
    if (!note) return null;

    const [summary, prescriptions] = await Promise.all([
      this.db.selectFrom('post_visit_summary').selectAll()
        .where('visit_note_id', '=', note.id).executeTakeFirst(),
      this.db.selectFrom('prescription').selectAll()
        .where('visit_note_id', '=', note.id).execute(),
    ]);

    if (summary?.status === 'SUCCESS') {
      return {
        status: 'SUCCESS',
        summaryText: summary.summary_text,
        medicationSchedule: (summary.med_schedule as any) ?? [],
        followUpSteps: summary.follow_up_steps ?? [],
        errorMessage: null,
        fallback: false,
      };
    }

    return {
      status: summary?.status ?? 'PENDING',
      summaryText: note.diagnosis ? `Diagnosis recorded: ${note.diagnosis}.` : null,
      medicationSchedule: prescriptions.map((p) => ({
        drug: `${p.drug_name} ${p.dosage}`,
        when: describePrescription({
          drugName: p.drug_name, dosage: p.dosage, frequency: p.frequency,
          durationDays: p.duration_days, instructions: p.instructions,
        }),
        duration: `${p.duration_days} day(s)`,
      })),
      followUpSteps: note.followUpDate
        ? [`Return for a follow-up on ${this.clock.date(new Date(note.followUpDate))}.`]
        : [],
      errorMessage: summary?.error_message ?? null,
      fallback: true,
    };
  }

  /** Re-attempts summaries that failed earlier. Driven by a repeatable job. */
  async retryFailed(limit = 20): Promise<{ preVisit: number; postVisit: number }> {
    const [pre, post] = await Promise.all([
      this.db.selectFrom('pre_visit_summary').select('appointment_id')
        .where('status', '=', 'FAILED').where('attempts', '<', 12)
        .orderBy('updated_at').limit(limit).execute(),
      this.db.selectFrom('post_visit_summary').select('visit_note_id')
        .where('status', '=', 'FAILED').where('attempts', '<', 12)
        .orderBy('updated_at').limit(limit).execute(),
    ]);

    let preOk = 0;
    let postOk = 0;
    for (const r of pre) {
      if ((await this.generatePreVisit(r.appointment_id)) === 'SUCCESS') preOk++;
    }
    for (const r of post) {
      if ((await this.generatePostVisit(r.visit_note_id)) === 'SUCCESS') postOk++;
    }
    return { preVisit: preOk, postVisit: postOk };
  }
}
