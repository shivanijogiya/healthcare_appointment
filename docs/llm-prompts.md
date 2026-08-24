# LLM prompts

Prompt text lives in `apps/api/src/llm/prompts/v1.ts` as versioned constants.
Every generated row stores `prompt_version`, so an output can always be traced
back to the exact instructions that produced it — and changing a prompt does not
retroactively invalidate the audit trail of what was already shown to a doctor.

The brief's two prompts are used verbatim as the user message. The system
message adds the output contract and the clinical guardrails around it.

## Configuration

| Variable | Default | Purpose |
|---|---|---|
| `LLM_PROVIDER` | `mock` | `mock`, `failing`, `anthropic`, `openai` |
| `LLM_MODEL` | `claude-sonnet-4-5` | Provider model id |
| `LLM_TIMEOUT_MS` | `15000` | Aborts the HTTP request, not just the promise |
| `LLM_MAX_ATTEMPTS` | `3` | Attempts per job, with jittered exponential backoff |
| `LLM_BREAKER_THRESHOLD` | `5` | Consecutive failures before the breaker opens |
| `LLM_BREAKER_COOLDOWN_MS` | `60000` | How long it stays open before a probe |

`mock` is a deterministic offline stub that returns schema-valid responses,
including urgency levels derived from symptom keywords. It exists so the whole
system is demoable with no API key. It is a stand-in for a model, not a clinical
tool.

## Pre-visit summary

Runs on the queue after an appointment is confirmed.

**System message**

```
You are a clinical intake assistant supporting a licensed doctor. You do not
diagnose and you do not prescribe. You triage and summarise.

Respond with ONLY a JSON object matching this schema. No markdown, no code
fences, no preamble:
{
  "urgency": "Low" | "Medium" | "High",
  "chief_complaint": string,
  "questions": [string, string, string]
}

Rules:
- urgency must be exactly one of Low, Medium, High. High means the patient may
  need same-day or emergency care.
- chief_complaint is one sentence in clinical shorthand, under 20 words.
- questions is exactly three specific questions the doctor should ask, each
  answerable in the consultation room.
- Never invent history the patient did not report.
```

**User message** — the brief's prompt, plus whatever structured context the
intake form captured:

```
Analyse these symptoms and return: urgency level (Low / Medium / High), chief
complaint, and three suggested questions for the doctor.

Symptoms: {{symptoms}}

Context:
- Age: {{age}}
- Gender: {{gender}}
- Duration: {{durationDays}} day(s)
- Patient-reported severity: {{severity}}/10
- Current medication: {{existingMeds}}
- Allergies: {{allergies}}
```

Context lines are omitted when the patient left them blank rather than being
sent as "unknown", which models tend to treat as a fact worth commenting on.

## Post-visit summary

Runs on the queue after a doctor files notes.

**System message**

```
You are a patient communication assistant. You rewrite a doctor's clinical notes
into plain language a patient can act on. You never add medication, dosage,
diagnosis or advice that is not in the notes.

Respond with ONLY a JSON object matching this schema. No markdown, no code
fences, no preamble:
{
  "summary": string,
  "medication_schedule": [{ "drug": string, "when": string, "duration": string }],
  "follow_up_steps": [string]
}

Rules:
- summary is 2-4 short sentences at a sixth-grade reading level, addressed to
  the patient as "you".
- medication_schedule must reproduce every prescribed drug exactly as given.
  "when" is plain language such as "one tablet in the morning and one at night,
  after food".
- follow_up_steps are concrete actions, including when to return and what
  warning signs mean they should come back sooner.
```

**User message**

```
Convert these clinical notes into a patient-friendly summary with medication
schedule and follow-up steps.

Notes: {{notes}}
Diagnosis: {{diagnosis}}
Prescriptions:
- {{drug}} {{dosage}}, {{frequency}}, {{durationDays}} day(s), {{instructions}}
Follow-up date: {{followUpDate}}
```

Prescriptions are passed as structured rows rather than being left for the model
to extract from prose, so the medication list cannot drift from what was actually
prescribed.

## Response handling

Responses are unwrapped (`extractJson` strips code fences and recovers an object
embedded in prose) and then validated with zod. Validation is strict by design:

| Situation | Behaviour |
|---|---|
| Valid JSON matching the schema | Stored, `status=SUCCESS` |
| Unparseable, or no JSON at all | Treated as a failure; raw text is never stored as a summary |
| Urgency missing or unrecognised (`Critical`, `HIGH`) | Whole response rejected — no defaulting |
| Fewer or more than three questions | Whole response rejected |
| Timeout, 5xx, rate limit | Retry up to `LLM_MAX_ATTEMPTS`, then `status=FAILED` |
| 5 consecutive failures | Breaker opens for 60s; further jobs fail fast |

Rejecting rather than defaulting is deliberate. An invented urgency level is
worse than no urgency level, because the doctor would have no way to know it was
invented.

## What happens when it fails

No model call is ever on the critical path of booking, cancellation or note
submission. Every one of those succeeds with the provider completely offline.

| Failure | System behaviour |
|---|---|
| Pre-visit `FAILED` | The doctor's workspace shows the raw symptom intake with an "AI summary unavailable" banner. The appointment is untouched. |
| Post-visit `FAILED` | The patient's email and portal show a medication plan rendered directly from `prescription` rows, flagged as a fallback. |
| Either | An hourly sweeper re-attempts failed summaries; a later success upgrades the stored row. |

Verified by `tests/failure-injection.mjs`, which runs the whole stack with
`LLM_PROVIDER=failing`.
