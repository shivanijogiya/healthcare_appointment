import {
  parseHHMM, formatHHMM, clinicWeekday, clinicLocalToUtc, clinicDateOf,
  overlaps, generateSlots, subtractBusy, isWithinAvailability, backoffMs,
} from '../src/scheduling/slot-math';

const IST = 330;

describe('time parsing', () => {
  it('parses HH:MM into minutes past midnight', () => {
    expect(parseHHMM('00:00')).toBe(0);
    expect(parseHHMM('09:30')).toBe(570);
    expect(parseHHMM('23:59')).toBe(1439);
  });

  it('rejects malformed and out-of-range times', () => {
    for (const bad of ['24:00', '9:00', '09:60', 'nine', '', '09:0']) {
      expect(() => parseHHMM(bad)).toThrow();
    }
  });

  it('round-trips through formatHHMM', () => {
    for (const t of ['00:00', '08:15', '13:45', '23:59']) {
      expect(formatHHMM(parseHHMM(t))).toBe(t);
    }
  });
});

describe('clinic-local conversion', () => {
  it('derives weekday independently of the server timezone', () => {
    expect(clinicWeekday('2026-09-01')).toBe(2); // a Tuesday
    expect(clinicWeekday('2026-09-06')).toBe(0); // a Sunday
  });

  it('converts clinic wall time to the correct instant', () => {
    // 09:00 IST is 03:30 UTC.
    const at = clinicLocalToUtc('2026-09-01', parseHHMM('09:00'), IST);
    expect(at.toISOString()).toBe('2026-09-01T03:30:00.000Z');
  });

  it('maps an instant back to the clinic-local calendar date', () => {
    // 20:00 UTC is already the next day in IST.
    expect(clinicDateOf(new Date('2026-09-01T20:00:00Z'), IST)).toBe('2026-09-02');
    expect(clinicDateOf(new Date('2026-09-01T03:30:00Z'), IST)).toBe('2026-09-01');
  });
});

describe('overlap semantics', () => {
  const range = (a: string, b: string) => ({ startsAt: new Date(a), endsAt: new Date(b) });

  it('treats touching ranges as non-overlapping', () => {
    // This is what makes back-to-back slots legal.
    expect(overlaps(
      range('2026-09-01T09:00:00Z', '2026-09-01T09:15:00Z'),
      range('2026-09-01T09:15:00Z', '2026-09-01T09:30:00Z'),
    )).toBe(false);
  });

  it('detects partial and complete overlap', () => {
    expect(overlaps(
      range('2026-09-01T09:00:00Z', '2026-09-01T09:30:00Z'),
      range('2026-09-01T09:15:00Z', '2026-09-01T09:45:00Z'),
    )).toBe(true);
    expect(overlaps(
      range('2026-09-01T09:00:00Z', '2026-09-01T10:00:00Z'),
      range('2026-09-01T09:15:00Z', '2026-09-01T09:30:00Z'),
    )).toBe(true);
  });
});

describe('slot generation', () => {
  const windows = [{ weekday: 2, startTime: '09:00', endTime: '13:00' }];

  it('divides a window into fixed-length slots', () => {
    const slots = generateSlots({ date: '2026-09-01', windows, slotDurationMin: 30, offsetMinutes: IST });
    expect(slots).toHaveLength(8); // 4 hours / 30 min
    expect(slots[0].startsAt.toISOString()).toBe('2026-09-01T03:30:00.000Z');
    expect(slots[7].endsAt.toISOString()).toBe('2026-09-01T07:30:00.000Z');
  });

  it('discards a trailing remainder shorter than one slot', () => {
    const slots = generateSlots({
      date: '2026-09-01',
      windows: [{ weekday: 2, startTime: '09:00', endTime: '10:50' }],
      slotDurationMin: 30,
      offsetMinutes: IST,
    });
    // 110 minutes yields three 30-minute slots; the last 20 minutes are dropped
    // rather than offering a slot that runs past the end of the clinic session.
    expect(slots).toHaveLength(3);
  });

  it('returns nothing for a weekday the doctor does not work', () => {
    expect(generateSlots({ date: '2026-09-02', windows, slotDurationMin: 30, offsetMinutes: IST })).toHaveLength(0);
  });

  it('does not emit duplicates when windows overlap', () => {
    const slots = generateSlots({
      date: '2026-09-01',
      windows: [
        { weekday: 2, startTime: '09:00', endTime: '11:00' },
        { weekday: 2, startTime: '10:00', endTime: '12:00' },
      ],
      slotDurationMin: 60,
      offsetMinutes: IST,
    });
    expect(slots).toHaveLength(3); // 09, 10, 11 — not 4
    expect(new Set(slots.map((s) => s.startsAt.getTime())).size).toBe(3);
  });

  it('honours effectiveFrom and effectiveTo', () => {
    const future = generateSlots({
      date: '2026-09-01',
      windows: [{ ...windows[0], effectiveFrom: new Date('2027-01-01') }],
      slotDurationMin: 30,
      offsetMinutes: IST,
    });
    expect(future).toHaveLength(0);
  });

  it('rejects a non-positive slot duration', () => {
    expect(() => generateSlots({ date: '2026-09-01', windows, slotDurationMin: 0, offsetMinutes: IST })).toThrow();
  });
});

describe('busy subtraction', () => {
  const slots = generateSlots({
    date: '2026-09-01',
    windows: [{ weekday: 2, startTime: '09:00', endTime: '11:00' }],
    slotDurationMin: 60,
    offsetMinutes: IST,
  });

  it('removes slots that collide with a booking', () => {
    const busy = [{ startsAt: new Date('2026-09-01T03:30:00Z'), endsAt: new Date('2026-09-01T04:30:00Z') }];
    const free = subtractBusy({ slots, busy, now: new Date('2026-08-01T00:00:00Z') });
    expect(free).toHaveLength(1);
    expect(free[0].startsAt.toISOString()).toBe('2026-09-01T04:30:00.000Z');
  });

  it('removes slots already in the past', () => {
    const free = subtractBusy({ slots, busy: [], now: new Date('2026-09-01T05:00:00Z') });
    expect(free).toHaveLength(0);
  });

  it('applies a minimum lead time', () => {
    const free = subtractBusy({
      slots, busy: [], now: new Date('2026-09-01T03:00:00Z'), minLeadMinutes: 60,
    });
    // Earliest bookable becomes 04:00Z, so the 09:00 IST slot (03:30Z) is
    // excluded and only the 10:00 IST slot (04:30Z) survives.
    expect(free).toHaveLength(1);
    expect(free[0].startsAt.toISOString()).toBe('2026-09-01T04:30:00.000Z');
  });
});

describe('availability containment', () => {
  const windows = [{ weekday: 2, startTime: '09:00', endTime: '13:00' }];

  it('accepts a range inside working hours', () => {
    expect(isWithinAvailability({
      range: { startsAt: new Date('2026-09-01T04:00:00Z'), endsAt: new Date('2026-09-01T04:30:00Z') },
      windows, offsetMinutes: IST,
    })).toBe(true);
  });

  it('rejects a range that spills past the end of the session', () => {
    expect(isWithinAvailability({
      range: { startsAt: new Date('2026-09-01T07:00:00Z'), endsAt: new Date('2026-09-01T08:00:00Z') },
      windows, offsetMinutes: IST,
    })).toBe(false);
  });
});

describe('backoff', () => {
  it('grows with each attempt and stays within the cap', () => {
    for (let attempt = 0; attempt < 8; attempt++) {
      const ms = backoffMs(attempt, 500, 30_000);
      expect(ms).toBeGreaterThan(0);
      expect(ms).toBeLessThanOrEqual(30_000);
    }
  });

  it('applies jitter so retries do not synchronise', () => {
    const samples = new Set(Array.from({ length: 30 }, () => backoffMs(4)));
    expect(samples.size).toBeGreaterThan(1);
  });
});
