import { useCallback, useEffect, useState } from 'react';
import type {
  AppointmentDto, Frequency, LeaveConflict, PreVisitSummaryDto, PrescriptionDto,
} from '@ham/types';
import { api, RequestError } from '../lib/api';
import { useAuth } from '../lib/auth';
import * as fmt from '../lib/format';
import { Empty, ErrorNote, Field, Modal, Spinner, StateChip, UrgencyChip } from '../components/ui';

export default function DoctorPortal() {
  const [tab, setTab] = useState<'schedule' | 'leave'>('schedule');
  return (
    <div className="mx-auto max-w-5xl px-4 py-8">
      <nav className="mb-6 flex gap-1">
        {(['schedule', 'leave'] as const).map((t) => (
          <button key={t} onClick={() => setTab(t)}
            className={`rounded-lg px-3 py-1.5 text-sm font-medium ${tab === t ? 'bg-ink text-white' : 'text-muted hover:bg-line/40'}`}>
            {t === 'schedule' ? 'My schedule' : 'Time off'}
          </button>
        ))}
      </nav>
      {tab === 'schedule' ? <Schedule /> : <LeavePanel />}
    </div>
  );
}

// --------------------------------------------------------------- schedule ---

function Schedule() {
  const [date, setDate] = useState(fmt.todayLocal());
  const [list, setList] = useState<AppointmentDto[] | null>(null);
  const [error, setError] = useState('');
  const [open, setOpen] = useState<AppointmentDto | null>(null);

  const load = useCallback(async () => {
    setList(null);
    try { setList(await api.get<AppointmentDto[]>(`/doctor/appointments?date=${date}`)); }
    catch (e) { setError((e as Error).message); }
  }, [date]);

  useEffect(() => { load(); }, [load]);

  const days = Array.from({ length: 14 }, (_, i) => fmt.addDays(fmt.todayLocal(), i));

  return (
    <section>
      <div className="mb-4 flex gap-1.5 overflow-x-auto pb-2">
        {days.map((d) => (
          <button key={d} onClick={() => setDate(d)}
            className={`shrink-0 rounded-lg border px-3 py-2 text-center ${d === date ? 'border-teal bg-teal-soft' : 'border-line bg-card hover:bg-paper'}`}>
            <span className="block font-mono text-[11px] text-muted">{fmt.longDate(d).slice(0, 3)}</span>
            <span className="block text-sm font-semibold">{d.slice(8)}</span>
          </button>
        ))}
      </div>

      <h2 className="mb-3 text-lg font-semibold">{fmt.longDate(date)}</h2>
      <ErrorNote onRetry={load}>{error}</ErrorNote>

      {!list ? <Spinner label="Loading your day" /> : list.length === 0 ? (
        <Empty title="Nothing booked" hint="Patients who book this day will appear here." />
      ) : (
        <div className="space-y-2">
          {list.map((a) => (
            <button key={a.id} onClick={() => setOpen(a)}
              className="card flex w-full items-center gap-4 p-4 text-left hover:border-teal">
              <span className="font-mono text-sm tabular-nums">{fmt.time(a.startsAt)}</span>
              <span className="flex-1">
                <span className="block font-medium">{a.patientName}</span>
                <span className="block text-sm text-muted">
                  {a.hasVisitNote ? 'Notes filed' : a.hasIntake ? 'Symptom form submitted' : 'No symptom form'}
                </span>
              </span>
              <StateChip state={a.state} />
            </button>
          ))}
        </div>
      )}

      {open && <ConsultationDrawer appointment={open} onClose={() => { setOpen(null); load(); }} />}
    </section>
  );
}

/**
 * The consultation view. The AI summary sits at the top when it succeeded, but
 * the raw symptom intake is always rendered underneath — the doctor is never
 * left staring at an empty panel because a model was unavailable.
 */
function ConsultationDrawer({ appointment, onClose }: { appointment: AppointmentDto; onClose: () => void }) {
  const [data, setData] = useState<{ summary: PreVisitSummaryDto | null; intake: any } | null>(null);
  const [note, setNote] = useState<any>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    Promise.all([
      api.get<any>(`/doctor/appointments/${appointment.id}/pre-visit`),
      api.get<any>(`/doctor/appointments/${appointment.id}/visit-note`).catch(() => null),
    ])
      .then(([pre, filed]) => { setData(pre); setNote(filed); })
      .catch((e) => setError(e.message));
  }, [appointment.id]);

  return (
    <Modal title={`${appointment.patientName} · ${fmt.time(appointment.startsAt)}`} onClose={onClose}>
      <ErrorNote>{error}</ErrorNote>
      {!data && !error ? <Spinner label="Loading the patient's notes" /> : null}

      {data && (
        <div className="space-y-5">
          {data.summary?.status === 'SUCCESS' ? (
            <div className="rounded-lg border border-teal/25 bg-teal-soft p-3">
              <div className="mb-2 flex items-center justify-between gap-2">
                <span className="label">AI pre-visit summary</span>
                {data.summary.urgency && <UrgencyChip urgency={data.summary.urgency} />}
              </div>
              <p className="text-sm font-medium">{data.summary.chiefComplaint}</p>
              <ol className="mt-2 list-decimal space-y-1 pl-5 text-sm">
                {data.summary.questions.map((q: string, i: number) => <li key={i}>{q}</li>)}
              </ol>
              <p className="mt-2 font-mono text-[11px] text-muted">
                {data.summary.model} · prompt {data.summary.promptVersion}
              </p>
            </div>
          ) : (
            <div className="rounded-lg border border-amber/25 bg-amber-soft p-3 text-sm text-amber">
              <strong>AI summary unavailable.</strong>{' '}
              {data.summary?.status === 'SKIPPED'
                ? 'The patient did not submit a symptom form.'
                : 'The summariser could not be reached. The patient’s own words are below.'}
            </div>
          )}

          {data.intake ? (
            <div>
              <span className="label">What the patient wrote</span>
              <p className="mt-1.5 whitespace-pre-wrap rounded-lg bg-paper p-3 text-sm leading-relaxed">
                {data.intake.symptomsText}
              </p>
              <dl className="mt-2 grid grid-cols-2 gap-2 text-sm">
                {data.intake.durationDays != null && (
                  <div><dt className="label">Duration</dt><dd>{data.intake.durationDays} days</dd></div>
                )}
                {data.intake.severity != null && (
                  <div><dt className="label">Severity</dt><dd>{data.intake.severity}/10</dd></div>
                )}
                {data.intake.existingMeds && (
                  <div><dt className="label">Current medicines</dt><dd>{data.intake.existingMeds}</dd></div>
                )}
                {data.intake.allergies && (
                  <div><dt className="label">Allergies</dt><dd className="text-crimson">{data.intake.allergies}</dd></div>
                )}
              </dl>
            </div>
          ) : (
            <Empty title="No symptom form" hint="Ask the patient at the start of the consultation." />
          )}

          {note ? (
            <div>
              <span className="label">Notes already filed</span>
              <p className="mt-1.5 whitespace-pre-wrap rounded-lg bg-paper p-3 text-sm">{note.clinicalNotes}</p>
              {note.prescriptions?.length > 0 && (
                <ul className="mt-2 space-y-1 text-sm">
                  {note.prescriptions.map((p: any) => (
                    <li key={p.id} className="font-mono text-xs">
                      {p.drugName} {p.dosage} · {p.frequency} · {p.durationDays}d
                    </li>
                  ))}
                </ul>
              )}
            </div>
          ) : appointment.state === 'CONFIRMED' ? (
            <VisitNoteForm appointmentId={appointment.id} onFiled={onClose} />
          ) : null}
        </div>
      )}
    </Modal>
  );
}

const FREQUENCIES: { value: Frequency; label: string }[] = [
  { value: 'OD', label: 'OD — once a day' },
  { value: 'BD', label: 'BD — twice a day' },
  { value: 'TDS', label: 'TDS — three times a day' },
  { value: 'QID', label: 'QID — four times a day' },
  { value: 'SOS', label: 'SOS — only when needed' },
];

function VisitNoteForm({ appointmentId, onFiled }: { appointmentId: string; onFiled: () => void }) {
  const [clinicalNotes, setNotes] = useState('');
  const [diagnosis, setDiagnosis] = useState('');
  const [followUpDate, setFollowUp] = useState('');
  const [rows, setRows] = useState<PrescriptionDto[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const update = (i: number, patch: Partial<PrescriptionDto>) =>
    setRows(rows.map((r, idx) => (idx === i ? { ...r, ...patch } : r)));

  async function submit() {
    setBusy(true);
    setError('');
    try {
      await api.post(`/doctor/appointments/${appointmentId}/visit-note`, {
        clinicalNotes,
        diagnosis: diagnosis || undefined,
        followUpDate: followUpDate || undefined,
        prescriptions: rows.filter((r) => r.drugName && r.dosage),
      });
      onFiled();
    } catch (e) {
      setError((e as RequestError).message);
    } finally { setBusy(false); }
  }

  return (
    <div className="space-y-3 border-t border-line pt-4">
      <span className="label">File your notes</span>
      <Field label="Clinical notes">
        <textarea className="field min-h-24" value={clinicalNotes} onChange={(e) => setNotes(e.target.value)}
          placeholder="Examination findings, impression, and plan." />
      </Field>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Diagnosis">
          <input className="field" value={diagnosis} onChange={(e) => setDiagnosis(e.target.value)} />
        </Field>
        <Field label="Follow-up date">
          <input type="date" className="field" value={followUpDate} onChange={(e) => setFollowUp(e.target.value)} />
        </Field>
      </div>

      <div>
        <div className="flex items-center justify-between">
          <span className="label">Prescriptions</span>
          <button className="text-sm text-teal underline underline-offset-2"
            onClick={() => setRows([...rows, { drugName: '', dosage: '', frequency: 'BD', durationDays: 5 }])}>
            Add a medicine
          </button>
        </div>
        <p className="mt-1 text-xs text-muted">
          Frequency drives the reminder schedule the patient receives.
        </p>
        <div className="mt-2 space-y-2">
          {rows.map((r, i) => (
            <div key={i} className="grid grid-cols-12 gap-1.5">
              <input className="field col-span-4" placeholder="Amoxicillin" value={r.drugName}
                onChange={(e) => update(i, { drugName: e.target.value })} />
              <input className="field col-span-2" placeholder="500mg" value={r.dosage}
                onChange={(e) => update(i, { dosage: e.target.value })} />
              <select className="field col-span-3" value={r.frequency}
                onChange={(e) => update(i, { frequency: e.target.value as Frequency })}>
                {FREQUENCIES.map((f) => <option key={f.value} value={f.value}>{f.value}</option>)}
              </select>
              <input type="number" min={1} className="field col-span-2" value={r.durationDays}
                onChange={(e) => update(i, { durationDays: Number(e.target.value) })} />
              <button className="col-span-1 text-muted hover:text-crimson"
                onClick={() => setRows(rows.filter((_, idx) => idx !== i))} aria-label="Remove">✕</button>
            </div>
          ))}
        </div>
      </div>

      <ErrorNote>{error}</ErrorNote>
      <button className="btn-primary w-full" disabled={busy || clinicalNotes.trim().length < 10} onClick={submit}>
        {busy ? 'Filing…' : 'File notes and send the patient a summary'}
      </button>
    </div>
  );
}

// ------------------------------------------------------------------ leave ---

/**
 * Requesting time off is two steps on purpose. The first shows exactly who
 * would be stranded; nothing reaches a patient until a decision has been made
 * for every one of them.
 */
function LeavePanel() {
  const { user } = useAuth();
  const [range, setRange] = useState({ startsAt: '', endsAt: '', reason: '' });
  const [proposal, setProposal] = useState<any>(null);
  const [dispositions, setDispositions] = useState<Record<string, { action: string; newStartsAt?: string }>>({});
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<string>('');

  async function propose() {
    setBusy(true); setError(''); setDone('');
    try {
      const res = await api.post<any>(`/doctors/${user!.doctorId}/leave`, {
        startsAt: new Date(range.startsAt).toISOString(),
        endsAt: new Date(range.endsAt).toISOString(),
        reason: range.reason || undefined,
      });
      setProposal(res);
      setDispositions(Object.fromEntries(
        res.conflicts.map((c: LeaveConflict) => [
          c.appointmentId,
          res.suggestions?.[c.appointmentId]
            ? { action: 'REBOOK_SAME_DOCTOR', newStartsAt: res.suggestions[c.appointmentId] }
            : { action: 'CANCEL' },
        ]),
      ));
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  }

  async function apply() {
    setBusy(true); setError('');
    try {
      const res = await api.post<any>(`/doctors/${user!.doctorId}/leave/${proposal.leaveId}/resolve`, {
        dispositions: Object.entries(dispositions).map(([appointmentId, d]) => ({ appointmentId, ...d })),
      });
      setDone(`Time off applied. ${res.handled} appointment(s) handled and everyone has been emailed.`);
      setProposal(null);
    } catch (e) {
      const err = e as RequestError;
      setError(
        err.code === 'LEAVE_CONFLICT'
          ? `${err.message} Nothing was changed — adjust the times below and apply again.`
          : err.message,
      );
    } finally { setBusy(false); }
  }

  return (
    <section className="max-w-2xl space-y-4">
      {done && <div className="rounded-lg bg-teal-soft px-3 py-2 text-sm text-teal">{done}</div>}

      {!proposal ? (
        <div className="card space-y-3 p-4">
          <h2 className="font-semibold">Request time off</h2>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="From">
              <input type="datetime-local" className="field" value={range.startsAt}
                onChange={(e) => setRange({ ...range, startsAt: e.target.value })} />
            </Field>
            <Field label="Until">
              <input type="datetime-local" className="field" value={range.endsAt}
                onChange={(e) => setRange({ ...range, endsAt: e.target.value })} />
            </Field>
          </div>
          <Field label="Reason">
            <input className="field" value={range.reason}
              onChange={(e) => setRange({ ...range, reason: e.target.value })} placeholder="Conference" />
          </Field>
          <ErrorNote>{error}</ErrorNote>
          <button className="btn-primary" disabled={busy || !range.startsAt || !range.endsAt} onClick={propose}>
            {busy ? 'Checking…' : 'See who this affects'}
          </button>
        </div>
      ) : (
        <div className="card space-y-4 p-4">
          <div>
            <h2 className="font-semibold">
              {proposal.conflicts.length} appointment{proposal.conflicts.length === 1 ? '' : 's'} need a decision
            </h2>
            <p className="text-sm text-muted">
              Nothing has been sent to anyone yet. Choose what happens to each patient, then apply.
            </p>
          </div>

          {proposal.conflicts.length === 0 && (
            <Empty title="Nobody is affected" hint="You can apply this straight away." />
          )}

          {proposal.conflicts.map((c: LeaveConflict) => (
            <div key={c.appointmentId} className="rounded-lg border border-line p-3">
              <div className="flex items-baseline justify-between">
                <strong className="text-sm">{c.patientName}</strong>
                <span className="font-mono text-xs text-muted">{fmt.dateTime(c.startsAt)}</span>
              </div>
              <div className="mt-2 flex flex-wrap gap-2">
                {['REBOOK_SAME_DOCTOR', 'CANCEL'].map((action) => (
                  <button key={action}
                    onClick={() => setDispositions({
                      ...dispositions,
                      [c.appointmentId]: {
                        action,
                        newStartsAt: action === 'CANCEL' ? undefined
                          : dispositions[c.appointmentId]?.newStartsAt ?? proposal.suggestions?.[c.appointmentId],
                      },
                    })}
                    className={`chip border px-3 py-1 ${
                      dispositions[c.appointmentId]?.action === action
                        ? 'border-teal bg-teal-soft text-teal' : 'border-line text-muted'
                    }`}>
                    {action === 'CANCEL' ? 'Cancel' : 'Move'}
                  </button>
                ))}
              </div>
              {dispositions[c.appointmentId]?.action === 'REBOOK_SAME_DOCTOR' && (
                <input
                  type="datetime-local"
                  className="field mt-2"
                  value={(dispositions[c.appointmentId]?.newStartsAt ?? '').slice(0, 16)}
                  onChange={(e) => setDispositions({
                    ...dispositions,
                    [c.appointmentId]: {
                      action: 'REBOOK_SAME_DOCTOR',
                      newStartsAt: new Date(e.target.value).toISOString(),
                    },
                  })}
                />
              )}
            </div>
          ))}

          <ErrorNote>{error}</ErrorNote>
          <div className="flex gap-2">
            <button className="btn-ghost" onClick={() => { setProposal(null); setError(''); }}>Back</button>
            <button className="btn-primary flex-1" disabled={busy} onClick={apply}>
              {busy ? 'Applying…' : 'Apply and notify everyone'}
            </button>
          </div>
        </div>
      )}
    </section>
  );
}
