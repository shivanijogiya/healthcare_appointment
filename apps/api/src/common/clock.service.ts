import { Injectable } from '@nestjs/common';
import { loadConfig } from '../config/env';
import { clinicDateOf, toClinicLocal } from '../scheduling/slot-math';

const DAYS = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
const MONTHS = ['January','February','March','April','May','June','July','August','September','October','November','December'];

/**
 * The clinic runs on a fixed UTC offset, so all wall-clock rendering happens here
 * rather than relying on the server's own timezone (which differs between a
 * laptop, CI, and a Render container).
 */
@Injectable()
export class ClockService {
  readonly offsetMinutes = loadConfig().CLINIC_TIMEZONE_OFFSET_MINUTES;

  now(): Date { return new Date(); }

  /** Clinic-local calendar date of an instant, "YYYY-MM-DD". */
  dateOf(instant: Date): string { return clinicDateOf(instant, this.offsetMinutes); }

  /** "2026-09-01 09:30" in clinic-local time. */
  localOf(instant: Date): string { return toClinicLocal(instant, this.offsetMinutes); }

  /** "9:30 AM" */
  time(instant: Date): string {
    const [, hm] = this.localOf(instant).split(' ');
    const [h, m] = hm.split(':').map(Number);
    const suffix = h < 12 ? 'AM' : 'PM';
    const hour12 = h % 12 === 0 ? 12 : h % 12;
    return `${hour12}:${String(m).padStart(2, '0')} ${suffix}`;
  }

  /** "Tuesday 1 September 2026" */
  date(instant: Date): string {
    const d = new Date(instant.getTime() + this.offsetMinutes * 60_000);
    return `${DAYS[d.getUTCDay()]} ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
  }

  /** "Tuesday 1 September 2026 at 9:30 AM" */
  dateTime(instant: Date): string { return `${this.date(instant)} at ${this.time(instant)}`; }

  addMinutes(d: Date, m: number): Date { return new Date(d.getTime() + m * 60_000); }
}
