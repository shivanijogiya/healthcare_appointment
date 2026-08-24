import { Inject, Injectable } from '@nestjs/common';
import bcrypt from 'bcryptjs';
import type { Db } from '@ham/db';
import type { AuthUser, DoctorSummary } from '@ham/types';
import { DB } from '../db/db.module';
import { AppError } from '../common/errors/app-error';
import { AuditService } from '../common/audit.service';
import { parseHHMM } from '../scheduling/slot-math';
import { CreateDoctorDto, SetAvailabilityDto, UpdateDoctorDto } from './dto';

@Injectable()
export class DoctorsService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly audit: AuditService,
  ) {}

  private readonly base = () =>
    this.db
      .selectFrom('doctor')
      .innerJoin('app_user', 'app_user.id', 'doctor.user_id')
      .select([
        'doctor.id as id',
        'app_user.name as name',
        'app_user.email as email',
        'doctor.specialisation as specialisation',
        'doctor.qualification as qualification',
        'doctor.slot_duration_min as slotDurationMin',
        'doctor.consult_fee as consultFee',
        'doctor.bio as bio',
        'doctor.gcal_refresh_token as gcalToken',
      ]);

  private static toSummary(r: any): DoctorSummary {
    return {
      id: r.id,
      name: r.name,
      email: r.email,
      specialisation: r.specialisation,
      qualification: r.qualification,
      slotDurationMin: r.slotDurationMin,
      consultFee: r.consultFee == null ? null : Number(r.consultFee),
      bio: r.bio,
      calendarConnected: Boolean(r.gcalToken),
    };
  }

  async search(specialisation?: string, q?: string): Promise<DoctorSummary[]> {
    let query = this.base();
    if (specialisation) query = query.where('doctor.specialisation', 'ilike', specialisation);
    if (q) {
      query = query.where((eb) =>
        eb.or([
          eb('app_user.name', 'ilike', `%${q}%`),
          eb('doctor.specialisation', 'ilike', `%${q}%`),
        ]),
      );
    }
    const rows = await query.orderBy('app_user.name').execute();
    return rows.map(DoctorsService.toSummary);
  }

  async specialisations(): Promise<string[]> {
    const rows = await this.db
      .selectFrom('doctor').select('specialisation').distinct().orderBy('specialisation').execute();
    return rows.map((r) => r.specialisation);
  }

  async byId(id: string): Promise<DoctorSummary> {
    const row = await this.base().where('doctor.id', '=', id).executeTakeFirst();
    if (!row) throw AppError.notFound('Doctor');
    return DoctorsService.toSummary(row);
  }

  async availability(doctorId: string) {
    return this.db
      .selectFrom('doctor_availability')
      .select(['id', 'weekday', 'start_time as startTime', 'end_time as endTime',
               'effective_from as effectiveFrom', 'effective_to as effectiveTo'])
      .where('doctor_id', '=', doctorId)
      .orderBy('weekday').orderBy('start_time')
      .execute();
  }

  async create(actor: AuthUser, dto: CreateDoctorDto): Promise<DoctorSummary> {
    const email = dto.email.toLowerCase().trim();
    const exists = await this.db
      .selectFrom('app_user').select('id').where('email', '=', email).executeTakeFirst();
    if (exists) throw AppError.conflict('An account with that email already exists.');

    const doctorId = await this.db.transaction().execute(async (trx) => {
      const user = await trx
        .insertInto('app_user')
        .values({
          email,
          name: dto.name.trim(),
          phone: dto.phone ?? null,
          role: 'DOCTOR',
          password_hash: await bcrypt.hash(dto.password, 10),
        })
        .returning(['id'])
        .executeTakeFirstOrThrow();

      const doc = await trx
        .insertInto('doctor')
        .values({
          user_id: user.id,
          specialisation: dto.specialisation.trim(),
          qualification: dto.qualification ?? null,
          slot_duration_min: dto.slotDurationMin ?? 15,
          consult_fee: dto.consultFee ?? null,
          bio: dto.bio ?? null,
        })
        .returning(['id'])
        .executeTakeFirstOrThrow();
      return doc.id;
    });

    await this.audit.record({
      actor, action: 'doctor.create', entity: 'doctor', entityId: doctorId, metadata: { email },
    });
    return this.byId(doctorId);
  }

  async update(actor: AuthUser, doctorId: string, dto: UpdateDoctorDto): Promise<DoctorSummary> {
    this.assertScope(actor, doctorId);
    const doctor = await this.db
      .selectFrom('doctor').select(['id', 'user_id']).where('id', '=', doctorId).executeTakeFirst();
    if (!doctor) throw AppError.notFound('Doctor');

    await this.db.transaction().execute(async (trx) => {
      if (dto.name) {
        await trx.updateTable('app_user').set({ name: dto.name.trim() })
          .where('id', '=', doctor.user_id).execute();
      }
      const patch: Record<string, unknown> = {};
      if (dto.specialisation !== undefined) patch.specialisation = dto.specialisation.trim();
      if (dto.qualification !== undefined) patch.qualification = dto.qualification;
      if (dto.slotDurationMin !== undefined) patch.slot_duration_min = dto.slotDurationMin;
      if (dto.consultFee !== undefined) patch.consult_fee = dto.consultFee;
      if (dto.bio !== undefined) patch.bio = dto.bio;
      if (Object.keys(patch).length) {
        await trx.updateTable('doctor').set(patch as any).where('id', '=', doctorId).execute();
      }
    });

    await this.audit.record({ actor, action: 'doctor.update', entity: 'doctor', entityId: doctorId });
    return this.byId(doctorId);
  }

  /**
   * Replaces the whole weekly pattern in one transaction.
   *
   * Changing hours never touches existing appointments: a booking already made
   * for a time that is no longer offered stays valid and simply stops being
   * offered to anyone new. Retroactively cancelling patients because an admin
   * edited a schedule would be far worse than a slightly odd-looking calendar.
   */
  async setAvailability(actor: AuthUser, doctorId: string, dto: SetAvailabilityDto) {
    this.assertScope(actor, doctorId);
    const doctor = await this.db
      .selectFrom('doctor').select('id').where('id', '=', doctorId).executeTakeFirst();
    if (!doctor) throw AppError.notFound('Doctor');

    for (const w of dto.windows) {
      if (parseHHMM(w.endTime) <= parseHHMM(w.startTime)) {
        throw AppError.conflict(`Window ${w.startTime}–${w.endTime} ends before it starts.`);
      }
    }
    // Overlapping windows on the same weekday would generate duplicate slots.
    const byDay = new Map<number, { s: number; e: number }[]>();
    for (const w of dto.windows) {
      const list = byDay.get(w.weekday) ?? [];
      const s = parseHHMM(w.startTime);
      const e = parseHHMM(w.endTime);
      if (list.some((x) => s < x.e && x.s < e)) {
        throw AppError.conflict(`Overlapping windows on weekday ${w.weekday}.`);
      }
      list.push({ s, e });
      byDay.set(w.weekday, list);
    }

    await this.db.transaction().execute(async (trx) => {
      await trx.deleteFrom('doctor_availability').where('doctor_id', '=', doctorId).execute();
      if (dto.windows.length) {
        await trx.insertInto('doctor_availability').values(
          dto.windows.map((w) => ({
            doctor_id: doctorId,
            weekday: w.weekday,
            start_time: w.startTime,
            end_time: w.endTime,
            effective_from: w.effectiveFrom ?? new Date().toISOString().slice(0, 10),
            effective_to: w.effectiveTo ?? null,
          })),
        ).execute();
      }
    });

    await this.audit.record({
      actor, action: 'doctor.availability.set', entity: 'doctor', entityId: doctorId,
      metadata: { windows: dto.windows.length },
    });
    return this.availability(doctorId);
  }

  private assertScope(actor: AuthUser, doctorId: string) {
    if (actor.role === 'ADMIN') return;
    if (actor.role === 'DOCTOR' && actor.doctorId === doctorId) return;
    throw AppError.forbidden();
  }
}
