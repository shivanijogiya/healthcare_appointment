import {
  doseTimesFor, expandDoseTimes, describePrescription, isKnownFrequency, FREQUENCY_TIMES,
} from '../src/visits/medication-schedule';

const IST = 330;

describe('frequency mapping', () => {
  it('maps each code to the right number of daily doses', () => {
    expect(doseTimesFor('OD')).toHaveLength(1);
    expect(doseTimesFor('BD')).toHaveLength(2);
    expect(doseTimesFor('TDS')).toHaveLength(3);
    expect(doseTimesFor('QID')).toHaveLength(4);
    expect(doseTimesFor('SOS')).toHaveLength(0);
  });

  it('is case-insensitive', () => {
    expect(doseTimesFor('bd')).toEqual(FREQUENCY_TIMES.BD);
  });

  it('recognises only the standard codes', () => {
    expect(isKnownFrequency('TDS')).toBe(true);
    expect(isKnownFrequency('WEEKLY')).toBe(false);
  });
});

describe('expandDoseTimes', () => {
  const from = new Date('2026-09-01T00:00:00Z'); // 05:30 IST

  it('produces one reminder per dose per day', () => {
    const times = expandDoseTimes({ frequency: 'BD', durationDays: 3, from, offsetMinutes: IST });
    expect(times).toHaveLength(6);
  });

  it('produces nothing for an as-needed prescription', () => {
    expect(expandDoseTimes({ frequency: 'SOS', durationDays: 30, from, offsetMinutes: IST })).toHaveLength(0);
  });

  it('drops doses that have already passed today', () => {
    // 15:00 IST — the 09:00 dose is gone, the 21:00 dose remains.
    const afternoon = new Date('2026-09-01T09:30:00Z');
    const times = expandDoseTimes({ frequency: 'BD', durationDays: 1, from: afternoon, offsetMinutes: IST });
    expect(times).toHaveLength(1);
  });

  it('caps a long course so the reminder table cannot be flooded', () => {
    const times = expandDoseTimes({
      frequency: 'QID', durationDays: 365, from, offsetMinutes: IST, maxDays: 90,
    });
    expect(times.length).toBeLessThanOrEqual(90 * 4);
  });

  it('returns instants in chronological order', () => {
    const times = expandDoseTimes({ frequency: 'TDS', durationDays: 2, from, offsetMinutes: IST });
    const sorted = [...times].sort((a, b) => a.getTime() - b.getTime());
    expect(times).toEqual(sorted);
  });

  it('ignores a zero-day course', () => {
    expect(expandDoseTimes({ frequency: 'OD', durationDays: 0, from, offsetMinutes: IST })).toHaveLength(0);
  });
});

describe('describePrescription', () => {
  it('renders a plain-language line for the degraded email', () => {
    const line = describePrescription({
      drugName: 'Amoxicillin', dosage: '500mg', frequency: 'TDS',
      durationDays: 5, instructions: 'after food',
    });
    expect(line).toContain('Amoxicillin 500mg');
    expect(line).toContain('Three times a day');
    expect(line).toContain('5 days');
    expect(line).toContain('after food');
  });

  it('handles an as-needed prescription', () => {
    const line = describePrescription({
      drugName: 'Sumatriptan', dosage: '50mg', frequency: 'SOS', durationDays: 30,
    });
    expect(line).toContain('as needed');
  });

  it('uses the singular for a one-day course', () => {
    const line = describePrescription({
      drugName: 'Ondansetron', dosage: '4mg', frequency: 'OD', durationDays: 1,
    });
    expect(line).toContain('for 1 day');
    expect(line).not.toContain('1 days');
  });
});
