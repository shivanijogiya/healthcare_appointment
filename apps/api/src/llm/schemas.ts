import { z } from 'zod';
import { Urgency } from '../common/enums';

/** Strict: an unrecognised urgency value fails the whole response. */
export const preVisitSchema = z.object({
  urgency: z.enum(['Low', 'Medium', 'High']),
  chief_complaint: z.string().min(1).max(400),
  questions: z.array(z.string().min(1)).length(3),
});
export type PreVisitPayload = z.infer<typeof preVisitSchema>;

export const postVisitSchema = z.object({
  summary: z.string().min(1),
  medication_schedule: z.array(
    z.object({ drug: z.string().min(1), when: z.string().min(1), duration: z.string().min(1) }),
  ),
  follow_up_steps: z.array(z.string().min(1)),
});
export type PostVisitPayload = z.infer<typeof postVisitSchema>;

export function toUrgencyEnum(value: PreVisitPayload['urgency']): Urgency {
  return value.toUpperCase() as Urgency;
}

/**
 * Models wrap JSON in prose or fences no matter how firmly you ask them not to.
 * This unwraps; anything still unparseable is treated as a failure, never stored.
 */
export function extractJson(raw: string): unknown {
  const trimmed = raw.trim();
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(trimmed);
  const candidate = fenced ? fenced[1].trim() : trimmed;

  try {
    return JSON.parse(candidate);
  } catch {
    const start = candidate.indexOf('{');
    const end = candidate.lastIndexOf('}');
    if (start !== -1 && end > start) {
      return JSON.parse(candidate.slice(start, end + 1));
    }
    throw new Error('Model response contained no JSON object.');
  }
}
