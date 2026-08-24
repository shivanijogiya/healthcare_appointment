/**
 * Pure slot arithmetic. No database, no clock reads beyond what is passed in —
 * everything here is unit-testable and deterministic.
 *
 * The clinic runs on a fixed UTC offset (CLINIC_TIMEZONE_OFFSET_MINUTES).
 * Availability is stored as clinic-local wall time ("09:00"); appointments are
 * stored as absolute instants. This module is the only place the two meet.
 */

export interface TimeRange {
  startsAt: Date;
  endsAt: Date;
}

export interface AvailabilityWindow {
  weekday: number; // 0 = Sunday .. 6 = Saturday
  startTime: string; // "09:00"
  endTime: string; // "13:00"
  effectiveFrom?: Date | null;
  effectiveTo?: Date | null;
}

const DAY_MS = 86_400_000;

export function parseHHMM(value: string): number {
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(value.trim());
  if (!match) throw new Error(`Invalid time "${value}". Use HH:MM, 24-hour.`);
  return Number(match[1]) * 60 + Number(match[2]);
}

export function formatHHMM(minutes: number): string {
  const h = Math.floor(minutes / 60) % 24;
  const m = minutes % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

/** Parses "YYYY-MM-DD" into its UTC midnight instant. */
export function parseClinicDate(date: string): Date {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date.trim());
  if (!match) throw new Error(`Invalid date "${date}". Use YYYY-MM-DD.`);
  const [, y, m, d] = match;
  const instant = Date.UTC(Number(y), Number(m) - 1, Number(d));
  const check = new Date(instant);
  if (check.getUTCMonth() !== Number(m) - 1 || check.getUTCDate() !== Number(d)) {
    throw new Error(`Invalid date "${date}".`);
  }
  return check;
}

/** Weekday of a clinic-local calendar date, independent of server timezone. */
export function clinicWeekday(date: string): number {
  return parseClinicDate(date).getUTCDay();
}

/** Converts a clinic-local wall time on a clinic date into an absolute instant. */
export function clinicLocalToUtc(date: string, minutesOfDay: number, offsetMinutes: number): Date {
  return new Date(parseClinicDate(date).getTime() + (minutesOfDay - offsetMinutes) * 60_000);
}

/** Renders an instant as clinic-local "YYYY-MM-DD HH:MM". */
export function toClinicLocal(instant: Date, offsetMinutes: number): string {
  const shifted = new Date(instant.getTime() + offsetMinutes * 60_000);
  const date = shifted.toISOString().slice(0, 10);
  const time = shifted.toISOString().slice(11, 16);
  return `${date} ${time}`;
}

/** The clinic-local calendar date an instant falls on. */
export function clinicDateOf(instant: Date, offsetMinutes: number): string {
  return new Date(instant.getTime() + offsetMinutes * 60_000).toISOString().slice(0, 10);
}

export function overlaps(a: TimeRange, b: TimeRange): boolean {
  // Half-open [start, end): touching ranges do not overlap.
  return a.startsAt.getTime() < b.endsAt.getTime() && b.startsAt.getTime() < a.endsAt.getTime();
}

/**
 * Expands availability windows for one clinic date into fixed-length slots.
 * A trailing remainder shorter than slotDurationMin is discarded.
 */
export function generateSlots(params: {
  date: string;
  windows: AvailabilityWindow[];
  slotDurationMin: number;
  offsetMinutes: number;
}): TimeRange[] {
  const { date, windows, slotDurationMin, offsetMinutes } = params;
  if (slotDurationMin <= 0) throw new Error('slotDurationMin must be positive.');

  const weekday = clinicWeekday(date);
  const dayStart = parseClinicDate(date);
  const dayEnd = new Date(dayStart.getTime() + DAY_MS);

  const slots: TimeRange[] = [];
  for (const window of windows) {
    if (window.weekday !== weekday) continue;
    if (window.effectiveFrom && window.effectiveFrom.getTime() > dayEnd.getTime()) continue;
    if (window.effectiveTo && window.effectiveTo.getTime() < dayStart.getTime()) continue;

    const from = parseHHMM(window.startTime);
    const to = parseHHMM(window.endTime);
    if (to <= from) continue;

    for (let cursor = from; cursor + slotDurationMin <= to; cursor += slotDurationMin) {
      slots.push({
        startsAt: clinicLocalToUtc(date, cursor, offsetMinutes),
        endsAt: clinicLocalToUtc(date, cursor + slotDurationMin, offsetMinutes),
      });
    }
  }

  const seen = new Set<number>();
  return slots
    .filter((slot) => {
      const key = slot.startsAt.getTime();
      if (seen.has(key)) return false; // overlapping windows must not duplicate a slot
      seen.add(key);
      return true;
    })
    .sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime());
}

/** Removes any slot that overlaps a busy range or has already started. */
export function subtractBusy(params: {
  slots: TimeRange[];
  busy: TimeRange[];
  now: Date;
  minLeadMinutes?: number;
}): TimeRange[] {
  const { slots, busy, now, minLeadMinutes = 0 } = params;
  const earliest = now.getTime() + minLeadMinutes * 60_000;
  return slots.filter(
    (slot) =>
      slot.startsAt.getTime() >= earliest && !busy.some((range) => overlaps(slot, range)),
  );
}

/** True when the range sits entirely inside one availability window. */
export function isWithinAvailability(params: {
  range: TimeRange;
  windows: AvailabilityWindow[];
  offsetMinutes: number;
}): boolean {
  const { range, windows, offsetMinutes } = params;
  const date = clinicDateOf(range.startsAt, offsetMinutes);
  const weekday = clinicWeekday(date);

  return windows.some((window) => {
    if (window.weekday !== weekday) return false;
    const start = clinicLocalToUtc(date, parseHHMM(window.startTime), offsetMinutes);
    const end = clinicLocalToUtc(date, parseHHMM(window.endTime), offsetMinutes);
    return (
      range.startsAt.getTime() >= start.getTime() && range.endsAt.getTime() <= end.getTime()
    );
  });
}

/** Exponential backoff with full jitter, capped. */
export function backoffMs(attempt: number, baseMs = 500, capMs = 30_000): number {
  const exponential = Math.min(capMs, baseMs * 2 ** attempt);
  return Math.round(exponential / 2 + Math.random() * (exponential / 2));
}
