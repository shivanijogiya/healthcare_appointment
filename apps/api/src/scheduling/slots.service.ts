import { Inject, Injectable } from '@nestjs/common';
import type { Db } from '@ham/db';
import type { Slot } from '@ham/types';
import { DB } from '../db/db.module';
import { AppError } from '../common/errors/app-error';
import { ClockService } from '../common/clock.service';
import {
  AvailabilityWindow,
  TimeRange,
  clinicWeekday,
  generateSlots,
  overlaps,
  parseClinicDate,
} from './slot-math';

export interface SlotGrid {
  doctorId: string;
  date: string;
  slotDurationMin: number;
  slots: Slot[];
}

const DAY_MS = 86_400_000;

/**
 * Slots are computed on read and never materialised into rows.
 *
 * A slot table becomes a second source of truth that drifts the instant a
 * doctor's working hours change, and it forces a backfill for every future
 * date. Generating on read means an availability edit takes effect immediately,
 * and the only durable record of "this time is taken" is an actual appointment
 * row — which is precisely what the exclusion constraint guards.
 */
@Injectable()
export class SlotsService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly clock: ClockService,
  ) {}

  private async windows(doctorId: string, date: string): Promise<AvailabilityWindow[]> {
    const rows = await this.db
      .selectFrom('doctor_availability')
      .select(['weekday', 'start_time', 'end_time', 'effective_from', 'effective_to'])
      .where('doctor_id', '=', doctorId)
      .where('weekday', '=', clinicWeekday(date))
      .execute();

    return rows.map((r) => ({
      weekday: r.weekday,
      startTime: r.start_time,
      endTime: r.end_time,
      effectiveFrom: r.effective_from ? new Date(r.effective_from) : null,
      effectiveTo: r.effective_to ? new Date(r.effective_to) : null,
    }));
  }

  /** Leave and live appointments, as opaque busy ranges. */
  private async busy(doctorId: string, date: string): Promise<{ leave: TimeRange[]; booked: TimeRange[] }> {
    const dayStart = new Date(parseClinicDate(date).getTime() - this.clock.offsetMinutes * 60_000);
    const dayEnd = new Date(dayStart.getTime() + DAY_MS);
    const now = this.clock.now();

    const [leaveRows, apptRows] = await Promise.all([
      this.db
        .selectFrom('doctor_leave')
        .select(['starts_at', 'ends_at'])
        .where('doctor_id', '=', doctorId)
        .where('status', '=', 'APPLIED')
        .where('starts_at', '<', dayEnd)
        .where('ends_at', '>', dayStart)
        .execute(),

      // A HELD row whose TTL has lapsed must not block a booking even if the
      // sweeper has not run yet — correctness cannot depend on job punctuality.
      this.db
        .selectFrom('appointment')
        .select(['starts_at', 'ends_at'])
        .where('doctor_id', '=', doctorId)
        .where('starts_at', '<', dayEnd)
        .where('ends_at', '>', dayStart)
        .where((eb) =>
          eb.or([
            eb('state', '=', 'CONFIRMED'),
            eb.and([eb('state', '=', 'HELD'), eb('hold_expires_at', '>', now)]),
          ]),
        )
        .execute(),
    ]);

    const toRange = (r: { starts_at: Date; ends_at: Date }): TimeRange => ({
      startsAt: new Date(r.starts_at),
      endsAt: new Date(r.ends_at),
    });
    return { leave: leaveRows.map(toRange), booked: apptRows.map(toRange) };
  }

  /**
   * The full grid for a day, including unavailable slots and why. Showing a
   * greyed-out 10:00 marked "booked" is more useful to a patient than silently
   * omitting it.
   */
  async gridFor(doctorId: string, date: string): Promise<SlotGrid> {
    const doctor = await this.db
      .selectFrom('doctor')
      .select(['id', 'slot_duration_min'])
      .where('id', '=', doctorId)
      .executeTakeFirst();
    if (!doctor) throw AppError.notFound('Doctor');

    const [windows, { leave, booked }] = await Promise.all([
      this.windows(doctorId, date),
      this.busy(doctorId, date),
    ]);

    const now = this.clock.now();
    const slots: Slot[] = generateSlots({
      date,
      windows,
      slotDurationMin: doctor.slot_duration_min,
      offsetMinutes: this.clock.offsetMinutes,
    }).map((slot) => {
      let available = true;
      let reason: Slot['reason'];

      if (slot.startsAt.getTime() <= now.getTime()) {
        available = false;
        reason = 'PAST';
      } else if (leave.some((l) => overlaps(slot, l))) {
        available = false;
        reason = 'LEAVE';
      } else if (booked.some((b) => overlaps(slot, b))) {
        available = false;
        reason = 'BOOKED';
      }

      return {
        startsAt: slot.startsAt.toISOString(),
        endsAt: slot.endsAt.toISOString(),
        available,
        reason,
      };
    });

    return { doctorId, date, slotDurationMin: doctor.slot_duration_min, slots };
  }

  /**
   * Validates a requested instant against working hours and leave, returning the
   * slot's end. Collisions are the exclusion constraint's job; this answers the
   * different question of "is that even a slot this doctor offers?".
   */
  async resolveSlot(doctorId: string, startsAt: Date): Promise<{ endsAt: Date }> {
    const grid = await this.gridFor(doctorId, this.clock.dateOf(startsAt));
    const match = grid.slots.find((s) => new Date(s.startsAt).getTime() === startsAt.getTime());

    if (!match) throw AppError.slotUnavailable('That time is not one of this doctor’s slots.');
    if (!match.available) {
      if (match.reason === 'PAST') throw AppError.slotUnavailable('That slot is in the past.');
      if (match.reason === 'LEAVE') throw AppError.slotUnavailable('The doctor is on leave at that time.');
      throw AppError.slotTaken();
    }
    return { endsAt: new Date(match.endsAt) };
  }

  /** First free slot at or after `from`. Used when rebooking around leave. */
  async findNextFree(doctorId: string, from: Date, horizonDays = 21): Promise<TimeRange | null> {
    for (let i = 0; i <= horizonDays; i++) {
      const date = this.clock.dateOf(new Date(from.getTime() + i * DAY_MS));
      const grid = await this.gridFor(doctorId, date);
      const hit = grid.slots.find((s) => s.available && new Date(s.startsAt) >= from);
      if (hit) return { startsAt: new Date(hit.startsAt), endsAt: new Date(hit.endsAt) };
    }
    return null;
  }
}
