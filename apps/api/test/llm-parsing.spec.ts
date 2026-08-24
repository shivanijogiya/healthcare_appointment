import { extractJson, preVisitSchema, postVisitSchema, toUrgencyEnum } from '../src/llm/schemas';
import { CircuitBreaker } from '../src/llm/circuit-breaker';

describe('extractJson', () => {
  it('parses a bare JSON object', () => {
    expect(extractJson('{"a":1}')).toEqual({ a: 1 });
  });

  it('unwraps a fenced block, which models emit regardless of instructions', () => {
    expect(extractJson('```json\n{"a":1}\n```')).toEqual({ a: 1 });
    expect(extractJson('```\n{"a":1}\n```')).toEqual({ a: 1 });
  });

  it('recovers an object buried in prose', () => {
    expect(extractJson('Sure! Here you go:\n{"a":1}\nHope that helps.')).toEqual({ a: 1 });
  });

  it('throws when there is no JSON at all', () => {
    expect(() => extractJson('I cannot help with that.')).toThrow();
  });
});

describe('preVisitSchema', () => {
  const valid = {
    urgency: 'High',
    chief_complaint: 'Chest pain on exertion',
    questions: ['Does it radiate?', 'Any breathlessness?', 'Any prior cardiac history?'],
  };

  it('accepts a well-formed response', () => {
    expect(preVisitSchema.parse(valid)).toEqual(valid);
  });

  it('rejects an unrecognised urgency rather than defaulting', () => {
    // Storing an invented urgency would be worse than storing nothing, because
    // the doctor would trust it.
    expect(() => preVisitSchema.parse({ ...valid, urgency: 'Critical' })).toThrow();
    expect(() => preVisitSchema.parse({ ...valid, urgency: 'HIGH' })).toThrow();
  });

  it('rejects a missing urgency', () => {
    const { urgency, ...rest } = valid;
    expect(() => preVisitSchema.parse(rest)).toThrow();
  });

  it('requires exactly three questions', () => {
    expect(() => preVisitSchema.parse({ ...valid, questions: valid.questions.slice(0, 2) })).toThrow();
    expect(() => preVisitSchema.parse({ ...valid, questions: [...valid.questions, 'Extra?'] })).toThrow();
  });

  it('maps the model’s casing onto the stored enum', () => {
    expect(toUrgencyEnum('Low')).toBe('LOW');
    expect(toUrgencyEnum('Medium')).toBe('MEDIUM');
    expect(toUrgencyEnum('High')).toBe('HIGH');
  });
});

describe('postVisitSchema', () => {
  it('accepts a well-formed response', () => {
    const ok = {
      summary: 'You have a chest infection.',
      medication_schedule: [{ drug: 'Amoxicillin 500mg', when: 'three times a day', duration: '5 days' }],
      follow_up_steps: ['Return if the fever persists past 48 hours.'],
    };
    expect(postVisitSchema.parse(ok)).toEqual(ok);
  });

  it('rejects a malformed medication entry', () => {
    expect(() => postVisitSchema.parse({
      summary: 'ok',
      medication_schedule: [{ drug: 'Amoxicillin' }],
      follow_up_steps: [],
    })).toThrow();
  });
});

describe('CircuitBreaker', () => {
  it('stays closed below the threshold', () => {
    const b = new CircuitBreaker(3, 1000);
    b.recordFailure(); b.recordFailure();
    expect(b.isOpen()).toBe(false);
  });

  it('opens once the threshold is reached', () => {
    const b = new CircuitBreaker(3, 1000);
    for (let i = 0; i < 3; i++) b.recordFailure();
    expect(b.isOpen()).toBe(true);
    expect(b.state).toBe('open');
  });

  it('resets on success', () => {
    const b = new CircuitBreaker(3, 1000);
    b.recordFailure(); b.recordFailure();
    b.recordSuccess();
    b.recordFailure();
    expect(b.isOpen()).toBe(false);
  });

  it('half-opens after the cooldown, and one more failure re-trips it', () => {
    let now = 0;
    const b = new CircuitBreaker(3, 1000, () => now);
    for (let i = 0; i < 3; i++) b.recordFailure();
    expect(b.isOpen()).toBe(true);

    now = 1001;
    expect(b.isOpen()).toBe(false); // half-open: one probe allowed through
    b.recordFailure();
    expect(b.isOpen()).toBe(true);  // probe failed, straight back to open
  });
});
