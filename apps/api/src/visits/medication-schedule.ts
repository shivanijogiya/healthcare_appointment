import { clinicLocalToUtc, clinicDateOf, parseHHMM } from '../scheduling/slot-math';

/** Standard prescription frequency codes and their clinic-local dose times. */
export const FREQUENCY_TIMES: Record<string, string[]> = {
  OD: ['09:00'],
  BD: ['09:00', '21:00'],
  TDS: ['08:00', '14:00', '20:00'],
  QID: ['06:00', '12:00', '18:00', '00:00'],
  SOS: [],
};

export const FREQUENCY_LABELS: Record<string, string> = {
  OD: 'Once a day',
  BD: 'Twice a day',
  TDS: 'Three times a day',
  QID: 'Four times a day',
  SOS: 'Only when needed',
};

export function isKnownFrequency(frequency: string): boolean {
  return Object.prototype.hasOwnProperty.call(FREQUENCY_TIMES, frequency.toUpperCase());
}

export function doseTimesFor(frequency: string): string[] {
  return FREQUENCY_TIMES[frequency.toUpperCase()] ?? [];
}

/**
 * Expands a prescription into absolute reminder instants.
 * Doses already in the past are dropped; the horizon is capped so a long
 * course cannot flood the reminder table.
 */
export function expandDoseTimes(params: {
  frequency: string;
  durationDays: number;
  from: Date;
  offsetMinutes: number;
  maxDays?: number;
}): Date[] {
  const { frequency, durationDays, from, offsetMinutes, maxDays = 90 } = params;
  const times = doseTimesFor(frequency);
  if (!times.length || durationDays <= 0) return [];

  const days = Math.min(durationDays, maxDays);
  const startDate = clinicDateOf(from, offsetMinutes);
  const startMs = new Date(`${startDate}T00:00:00.000Z`).getTime();

  const instants: Date[] = [];
  for (let day = 0; day < days; day++) {
    const date = new Date(startMs + day * 86_400_000).toISOString().slice(0, 10);
    for (const time of times) {
      const at = clinicLocalToUtc(date, parseHHMM(time), offsetMinutes);
      if (at.getTime() > from.getTime()) instants.push(at);
    }
  }
  return instants.sort((a, b) => a.getTime() - b.getTime());
}

/** Human-readable schedule line used when the LLM summary is unavailable. */
export function describePrescription(p: {
  drugName: string;
  dosage: string;
  frequency: string;
  durationDays: number;
  instructions?: string | null;
}): string {
  const times = doseTimesFor(p.frequency);
  const when = times.length ? times.join(', ') : 'as needed';
  const label = FREQUENCY_LABELS[p.frequency.toUpperCase()] ?? p.frequency;
  const extra = p.instructions ? ` (${p.instructions})` : '';
  return `${p.drugName} ${p.dosage} — ${label} at ${when}, for ${p.durationDays} day${
    p.durationDays === 1 ? '' : 's'
  }${extra}`;
}
