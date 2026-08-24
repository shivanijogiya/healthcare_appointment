import * as Handlebars from 'handlebars';
import { NotificationType } from '../common/enums';

Handlebars.registerHelper('or', (a: unknown, b: unknown) => a || b);

const SHELL = `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>{{subject}}</title></head>
<body style="margin:0;background:#F2F0EB;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#14181F">
  <div style="max-width:560px;margin:0 auto;padding:32px 20px">
    <div style="font:600 13px/1 ui-monospace,SFMono-Regular,Menlo,monospace;letter-spacing:.14em;text-transform:uppercase;color:#0F5F5C">{{clinic}}</div>
    <div style="background:#fff;border:1px solid #DEDAD1;border-radius:14px;padding:28px;margin-top:14px">
      <h1 style="margin:0 0 14px;font-size:21px;line-height:1.25">{{heading}}</h1>
      {{{body}}}
    </div>
    <p style="margin:18px 2px 0;font-size:12px;color:#6C6A66">
      You are receiving this because you have an appointment with {{clinic}}.
    </p>
  </div>
</body></html>`;

const ROW = `<table style="width:100%;border-collapse:collapse;margin:16px 0;font-size:14px">
  <tr><td style="padding:7px 0;color:#6C6A66;width:132px">Doctor</td><td style="padding:7px 0;font-weight:600">{{doctorName}}{{#if specialisation}} · {{specialisation}}{{/if}}</td></tr>
  <tr><td style="padding:7px 0;color:#6C6A66">Patient</td><td style="padding:7px 0;font-weight:600">{{patientName}}</td></tr>
  <tr><td style="padding:7px 0;color:#6C6A66">When</td><td style="padding:7px 0;font-weight:600;font-family:ui-monospace,SFMono-Regular,Menlo,monospace">{{when}}</td></tr>
</table>`;

const BODIES: Record<string, { subject: string; heading: string; body: string }> = {
  BOOKING_CONFIRMED_PATIENT: {
    subject: 'Appointment confirmed — {{when}}',
    heading: 'Your appointment is confirmed',
    body: `${ROW}<p style="font-size:14px;line-height:1.6">Arrive ten minutes early. We will send a reminder 24 hours before.</p>
      <p style="font-size:14px;line-height:1.6">Need to change it? Cancel or reschedule from your portal.</p>`,
  },
  BOOKING_CONFIRMED_DOCTOR: {
    subject: 'New booking — {{when}}',
    heading: 'A patient booked a slot',
    body: `${ROW}<p style="font-size:14px;line-height:1.6">The AI pre-visit summary appears in your workspace once the intake form is processed.</p>`,
  },
  REMINDER_24H: {
    subject: 'Tomorrow: your appointment at {{when}}',
    heading: 'Your appointment is tomorrow',
    body: `${ROW}<p style="font-size:14px;line-height:1.6">If you can no longer attend, cancel now so the slot opens up for someone else.</p>`,
  },
  CANCELLED_PATIENT: {
    subject: 'Appointment cancelled — {{when}}',
    heading: 'Your appointment was cancelled',
    body: `${ROW}{{#if reason}}<p style="font-size:14px;line-height:1.6">Reason: {{reason}}</p>{{/if}}
      <p style="font-size:14px;line-height:1.6">You can book another slot any time from your portal.</p>`,
  },
  CANCELLED_DOCTOR: {
    subject: 'Cancelled booking — {{when}}',
    heading: 'A booking was cancelled',
    body: `${ROW}{{#if reason}}<p style="font-size:14px;line-height:1.6">Reason: {{reason}}</p>{{/if}}`,
  },
  LEAVE_RESCHEDULED: {
    subject: 'Your appointment has changed',
    heading: '{{#if newWhen}}Your appointment moved{{else}}Your appointment was cancelled{{/if}}',
    body: `<p style="font-size:14px;line-height:1.6">{{doctorName}} is on leave on {{originalWhen}}.</p>
      {{#if newWhen}}
        <p style="font-size:14px;line-height:1.6">We moved you to <strong style="font-family:ui-monospace,monospace">{{newWhen}}</strong>{{#if newDoctorName}} with {{newDoctorName}}{{/if}}. Your calendar event is updated.</p>
      {{else}}
        <p style="font-size:14px;line-height:1.6">We could not find an equivalent slot, so the appointment was cancelled. Book a new time from your portal whenever you are ready.</p>
      {{/if}}`,
  },
  LEAVE_SUMMARY_DOCTOR: {
    subject: 'Leave applied — {{affectedCount}} appointment(s) handled',
    heading: 'Your leave is applied',
    body: `<p style="font-size:14px;line-height:1.6">Leave from <strong>{{leaveFrom}}</strong> to <strong>{{leaveTo}}</strong>.</p>
      <p style="font-size:14px;line-height:1.6">{{affectedCount}} appointment(s) were handled:</p>
      <ul style="font-size:14px;line-height:1.7;padding-left:18px">{{#each changes}}<li>{{this}}</li>{{/each}}</ul>`,
  },
  POST_VISIT_SUMMARY: {
    subject: 'Your visit summary and medication plan',
    heading: 'After your visit',
    body: `{{#if summaryText}}<p style="font-size:14px;line-height:1.6">{{summaryText}}</p>{{/if}}
      {{#if medications.length}}
        <h2 style="font-size:15px;margin:20px 0 8px">Medication</h2>
        <ul style="font-size:14px;line-height:1.7;padding-left:18px">{{#each medications}}<li>{{this}}</li>{{/each}}</ul>
      {{/if}}
      {{#if followUpSteps.length}}
        <h2 style="font-size:15px;margin:20px 0 8px">Next steps</h2>
        <ul style="font-size:14px;line-height:1.7;padding-left:18px">{{#each followUpSteps}}<li>{{this}}</li>{{/each}}</ul>
      {{/if}}
      {{#if followUpDate}}<p style="font-size:14px;line-height:1.6">Follow-up on <strong>{{followUpDate}}</strong>.</p>{{/if}}
      {{#if degraded}}<p style="font-size:12px;color:#6C6A66;margin-top:20px">This summary was generated directly from your prescription because the AI summariser was unavailable. Nothing is missing from your medication plan.</p>{{/if}}`,
  },
  MEDICATION: {
    subject: 'Time for your {{drugName}}',
    heading: 'Medication reminder',
    body: `<p style="font-size:14px;line-height:1.6">Take <strong>{{drugName}} {{dosage}}</strong> now.{{#if instructions}} {{instructions}}.{{/if}}</p>
      <p style="font-size:13px;color:#6C6A66">Prescribed by {{doctorName}} · course ends {{courseEnds}}</p>`,
  },
};

const CLINIC = 'Meridian Clinic';

export interface RenderedEmail {
  subject: string;
  html: string;
  text: string;
}

const cache = new Map<string, HandlebarsTemplateDelegate>();
function compile(source: string): HandlebarsTemplateDelegate {
  let tpl = cache.get(source);
  if (!tpl) {
    tpl = Handlebars.compile(source);
    cache.set(source, tpl);
  }
  return tpl;
}

export function renderEmail(type: NotificationType | string, payload: Record<string, any>): RenderedEmail {
  const template = BODIES[type];
  if (!template) throw new Error(`No email template for type "${type}"`);

  const data = { ...payload, clinic: CLINIC };
  const subject = compile(template.subject)(data);
  const body = compile(template.body)(data);
  const html = compile(SHELL)({ ...data, subject, heading: compile(template.heading)(data), body });

  return { subject, html, text: htmlToText(html) };
}

function htmlToText(html: string): string {
  return html
    .replace(/<head[\s\S]*?<\/head>/gi, '')
    .replace(/<li>/gi, '\n  - ')
    .replace(/<\/(p|h1|h2|tr|div|ul)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n\s*\n+/g, '\n\n')
    .trim();
}
