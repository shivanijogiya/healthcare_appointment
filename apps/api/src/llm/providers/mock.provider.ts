import { CompletionRequest, LlmProvider } from './provider.interface';

const RED_FLAGS = [
  'chest pain',
  'shortness of breath',
  'breathless',
  'bleeding',
  'unconscious',
  'fainted',
  'slurred',
  'numbness on one side',
  'severe abdominal',
  'suicidal',
];

/**
 * Deterministic offline provider. Lets a reviewer exercise the entire pipeline
 * — including urgency levels and post-visit summaries — with no API key.
 * It is a stand-in for a model, not a clinical tool.
 */
export class MockProvider implements LlmProvider {
  readonly name = 'mock';
  readonly model = 'mock-clinical-v1';

  async complete(request: CompletionRequest): Promise<string> {
    await new Promise((resolve) => setTimeout(resolve, 120));
    return request.system.includes('clinical intake assistant')
      ? JSON.stringify(this.preVisit(request.user))
      : JSON.stringify(this.postVisit(request.user));
  }

  private preVisit(user: string) {
    const text = user.toLowerCase();
    const severity = Number(/severity: (\d+)\/10/.exec(text)?.[1] ?? 0);
    const days = Number(/duration: (\d+) day/.exec(text)?.[1] ?? 0);

    let urgency: 'Low' | 'Medium' | 'High' = 'Low';
    if (severity >= 4 || days >= 7) urgency = 'Medium';
    if (severity >= 8 || RED_FLAGS.some((flag) => text.includes(flag))) urgency = 'High';

    const symptoms = (/symptoms: (.*)/i.exec(user)?.[1] ?? 'unspecified symptoms')
      .split('\n')[0]
      .trim();

    return {
      urgency,
      chief_complaint: symptoms.length > 90 ? `${symptoms.slice(0, 87)}...` : symptoms,
      questions: [
        'When did the symptoms start and has anything made them noticeably better or worse?',
        'Have you had any fever, weight loss, or night sweats alongside this?',
        'Are you taking any medication or supplement that started around the same time?',
      ],
    };
  }

  private postVisit(user: string) {
    const notes = (/notes: ([\s\S]*?)(\n\n|$)/i.exec(user)?.[1] ?? '').trim();
    const meds = [...user.matchAll(/^- (.+?) (\S+), (\w+), (\d+) day/gm)].map((m) => ({
      drug: m[1],
      when: readableFrequency(m[3]),
      duration: `${m[4]} days`,
    }));
    const followUp = /follow-up date: (.+)/i.exec(user)?.[1];

    return {
      summary: notes
        ? `Here is what the doctor found: ${notes.slice(0, 320)}. Follow the medication plan below and get in touch if anything gets worse.`
        : 'Your visit is complete. Follow the plan below and get in touch if anything gets worse.',
      medication_schedule: meds,
      follow_up_steps: [
        'Take every dose at the times listed, even once you feel better.',
        followUp ? `Come back for a follow-up on ${followUp}.` : 'Book a follow-up if symptoms persist beyond a week.',
        'Seek care sooner if you develop a high fever, severe pain, or difficulty breathing.',
      ],
    };
  }
}

function readableFrequency(code: string): string {
  const map: Record<string, string> = {
    OD: 'once a day, in the morning',
    BD: 'twice a day, morning and night',
    TDS: 'three times a day, after meals',
    QID: 'four times a day, every six hours',
    SOS: 'only when you need it',
  };
  return map[code.toUpperCase()] ?? code;
}
