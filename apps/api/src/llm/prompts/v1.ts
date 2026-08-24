/**
 * Prompt text is versioned. `promptVersion` is stored on every generated row so
 * an output can always be traced back to the exact instructions that produced it.
 */
export const PROMPT_VERSION = 'v1';

export const PRE_VISIT_SYSTEM = `You are a clinical intake assistant supporting a licensed doctor. You do not diagnose and you do not prescribe. You triage and summarise.

Respond with ONLY a JSON object matching this schema. No markdown, no code fences, no preamble:
{
  "urgency": "Low" | "Medium" | "High",
  "chief_complaint": string,
  "questions": [string, string, string]
}

Rules:
- urgency must be exactly one of Low, Medium, High. High means the patient may need same-day or emergency care.
- chief_complaint is one sentence in clinical shorthand, under 20 words.
- questions is exactly three specific questions the doctor should ask, each answerable in the consultation room.
- Never invent history the patient did not report.`;

export function preVisitUserPrompt(input: {
  symptoms: string;
  durationDays?: number | null;
  severity?: number | null;
  existingMeds?: string | null;
  allergies?: string | null;
  patientAge?: number | null;
  gender?: string | null;
}): string {
  const context: string[] = [];
  if (input.patientAge != null) context.push(`Age: ${input.patientAge}`);
  if (input.gender) context.push(`Gender: ${input.gender}`);
  if (input.durationDays != null) context.push(`Duration: ${input.durationDays} day(s)`);
  if (input.severity != null) context.push(`Patient-reported severity: ${input.severity}/10`);
  if (input.existingMeds) context.push(`Current medication: ${input.existingMeds}`);
  if (input.allergies) context.push(`Allergies: ${input.allergies}`);

  return [
    'Analyse these symptoms and return: urgency level (Low / Medium / High), chief complaint, and three suggested questions for the doctor.',
    `Symptoms: ${input.symptoms}`,
    context.length ? `Context:\n${context.map((c) => `- ${c}`).join('\n')}` : '',
  ]
    .filter(Boolean)
    .join('\n\n');
}

export const POST_VISIT_SYSTEM = `You are a patient communication assistant. You rewrite a doctor's clinical notes into plain language a patient can act on. You never add medication, dosage, diagnosis or advice that is not in the notes.

Respond with ONLY a JSON object matching this schema. No markdown, no code fences, no preamble:
{
  "summary": string,
  "medication_schedule": [{ "drug": string, "when": string, "duration": string }],
  "follow_up_steps": [string]
}

Rules:
- summary is 2-4 short sentences at a sixth-grade reading level, addressed to the patient as "you".
- medication_schedule must reproduce every prescribed drug exactly as given. "when" is plain language such as "one tablet in the morning and one at night, after food".
- follow_up_steps are concrete actions, including when to return and what warning signs mean they should come back sooner.`;

export function postVisitUserPrompt(input: {
  notes: string;
  diagnosis?: string | null;
  prescriptions: Array<{
    drugName: string;
    dosage: string;
    frequency: string;
    durationDays: number;
    instructions?: string | null;
  }>;
  followUpDate?: string | null;
}): string {
  const meds = input.prescriptions.length
    ? input.prescriptions
        .map(
          (p) =>
            `- ${p.drugName} ${p.dosage}, ${p.frequency}, ${p.durationDays} day(s)${
              p.instructions ? `, ${p.instructions}` : ''
            }`,
        )
        .join('\n')
    : '- none prescribed';

  return [
    'Convert these clinical notes into a patient-friendly summary with medication schedule and follow-up steps.',
    `Notes: ${input.notes}`,
    input.diagnosis ? `Diagnosis: ${input.diagnosis}` : '',
    `Prescriptions:\n${meds}`,
    input.followUpDate ? `Follow-up date: ${input.followUpDate}` : '',
  ]
    .filter(Boolean)
    .join('\n\n');
}
