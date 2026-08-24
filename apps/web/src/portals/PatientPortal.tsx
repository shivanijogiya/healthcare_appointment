import { useCallback, useEffect, useMemo, useState } from 'react';
import type {
  AppointmentDto, DoctorSummary, PostVisitSummaryDto, Slot,
} from '@ham/types';
import { api, RequestError } from '../lib/api';
import * as fmt from '../lib/format';
import { Countdown, Empty, ErrorNote, Field, Modal, Spinner, StateChip } from '../components/ui';

interface SlotGrid { doctorId: string; date: string; slotDurationMin: number; slots: Slot[] }

export default function PatientPortal() {
  const [tab, setTab] = useState<'book' | 'appointments'>('book');
  const [appointments, setAppointments] = useState<AppointmentDto[]>([]);

  const loadAppointments = useCallback(async () => {
    setAppointments(await api.get<AppointmentDto[]>('/appointments/me'));
  }, []);

  useEffect(() => { loadAppointments().catch(() => {}); }, [loadAppointments]);

  return (
    <div className="mx-auto max-w-5xl px-4 py-8">
      <nav className="mb-6 flex gap-1" aria-label="Sections">
        {(['book', 'appointments'] as const).map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`rounded-lg px-3 py-1.5 text-sm font-medium ${
              tab === t ? 'bg-ink text-white' : 'text-muted hover:bg-line/40'
            }`}
          >
            {t === 'book' ? 'Find a doctor' : `My appointments (${appointments.length})`}
          </button>
        ))}
      </nav>

      {tab === 'book'
        ? <BookFlow onBooked={() => { loadAppointments(); setTab('appointments'); }} />
        : <Appointments list={appointments} reload={loadAppointments} />}
    </div>
  );
}

// ---------------------------------------------------------------- booking ---

function BookFlow({ onBooked }: { onBooked: () => void }) {
  const [doctors, setDoctors] = useState<DoctorSummary[]>([]);
  const [specialisations, setSpecialisations] = useState<string[]>([]);
  const [filter, setFilter] = useState('');
  const [selected, setSelected] = useState<DoctorSummary | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    Promise.all([
      api.get<DoctorSummary[]>('/doctors'),
      api.get<string[]>('/doctors/specialisations'),
    ])
      .then(([d, s]) => { setDoctors(d); setSpecialisations(s); })
      .catch((e) => setError(e.message));
  }, []);

  const visible = useMemo(
    () => (filter ? doctors.filter((d) => d.specialisation === filter) : doctors),
    [doctors, filter],
  );

  if (selected) return <SlotPicker doctor={selected} onBack={() => setSelected(null)} onBooked={onBooked} />;

  return (
    <section>
      <ErrorNote>{error}</ErrorNote>
      <div className="mb-4 flex flex-wrap gap-2">
        <button
          onClick={() => setFilter('')}
          className={`chip border px-3 py-1 ${!filter ? 'border-teal bg-teal-soft text-teal' : 'border-line text-muted'}`}
        >
          All
        </button>
        {specialisations.map((s) => (
          <button
            key={s}
            onClick={() => setFilter(s)}
            className={`chip border px-3 py-1 ${filter === s ? 'border-teal bg-teal-soft text-teal' : 'border-line text-muted'}`}
          >
            {s}
          </button>
        ))}
      </div>

      {!doctors.length && !error ? <Spinner label="Loading doctors" /> : null}

      <div className="grid gap-3 sm:grid-cols-2">
        {visible.map((d) => (
          <article key={d.id} className="card p-4">
            <span className="label">{d.specialisation}</span>
            <h3 className="mt-1 text-base font-semibold">{d.name}</h3>
            {d.qualification && <p className="text-sm text-muted">{d.qualification}</p>}
            {d.bio && <p className="mt-2 text-sm leading-relaxed text-muted">{d.bio}</p>}
            <div className="mt-3 flex items-center justify-between">
              <span className="font-mono text-xs text-muted">
                {d.slotDurationMin} min{d.consultFee != null ? ` · ₹${d.consultFee}` : ''}
              </span>
              <button className="btn-primary" onClick={() => setSelected(d)}>See times</button>
            </div>
          </article>
        ))}
      </div>
    </section>
  );
}

/**
 * The slot grid is the centre of the patient experience, so unavailable slots
 * are shown greyed out with their reason rather than hidden — "10:00 is booked"
 * is more useful than 10:00 silently not existing.
 */
function SlotPicker({ doctor, onBack, onBooked }: {
  doctor: DoctorSummary; onBack: () => void; onBooked: () => void;
}) {
  const [date, setDate] = useState(fmt.todayLocal());
  const [grid, setGrid] = useState<SlotGrid | null>(null);
  const [error, setError] = useState('');
  const [holding, setHolding] = useState<string | null>(null);
  const [hold, setHold] = useState<{ appointmentId: string; startsAt: string; holdExpiresAt: string } | null>(null);

  const load = useCallback(async () => {
    setGrid(null);
    setError('');
    try {
      setGrid(await api.get<SlotGrid>(`/doctors/${doctor.id}/slots?date=${date}`));
    } catch (e) {
      setError((e as Error).message);
    }
  }, [doctor.id, date]);

  useEffect(() => { load(); }, [load]);

  async function takeSlot(slot: Slot) {
    setHolding(slot.startsAt);
    setError('');
    try {
      const res = await api.post<{ appointmentId: string; startsAt: string; holdExpiresAt: string }>(
        '/appointments/hold',
        { doctorId: doctor.id, startsAt: slot.startsAt },
        // A retried request must not create a second hold.
        { 'idempotency-key': `${doctor.id}-${slot.startsAt}-${Date.now()}` },
      );
      setHold(res);
    } catch (e) {
      const err = e as RequestError;
      setError(
        err.code === 'SLOT_TAKEN'
          ? 'Someone booked that slot a moment ago. Pick another time.'
          : err.message,
      );
      load();
    } finally {
      setHolding(null);
    }
  }

  const days = Array.from({ length: 14 }, (_, i) => fmt.addDays(fmt.todayLocal(), i));

  return (
    <section>
      <button onClick={onBack} className="mb-4 text-sm text-muted hover:text-ink">← All doctors</button>
      <h2 className="text-lg font-semibold">{doctor.name}</h2>
      <p className="text-sm text-muted">{doctor.specialisation} · {doctor.slotDurationMin} minute appointments</p>

      <div className="mt-4 flex gap-1.5 overflow-x-auto pb-2">
        {days.map((d) => (
          <button
            key={d}
            onClick={() => setDate(d)}
            className={`shrink-0 rounded-lg border px-3 py-2 text-center ${
              d === date ? 'border-teal bg-teal-soft' : 'border-line bg-card hover:bg-paper'
            }`}
          >
            <span className="block font-mono text-[11px] text-muted">{fmt.longDate(d).slice(0, 3)}</span>
            <span className="block text-sm font-semibold">{d.slice(8)}</span>
          </button>
        ))}
      </div>

      <ErrorNote onRetry={load}>{error}</ErrorNote>

      {!grid ? <Spinner label="Checking availability" /> : grid.slots.length === 0 ? (
        <Empty title="No clinic on this day" hint="Try another date from the strip above." />
      ) : (
        <div className="mt-4 grid grid-cols-3 gap-2 sm:grid-cols-5">
          {grid.slots.map((s) => (
            <button
              key={s.startsAt}
              disabled={!s.available || holding !== null}
              onClick={() => takeSlot(s)}
              title={s.available ? 'Available' : s.reason === 'LEAVE' ? 'Doctor on leave' : s.reason === 'PAST' ? 'Already passed' : 'Booked'}
              className={`rounded-lg border py-2 font-mono text-sm ${
                s.available
                  ? 'border-line bg-card hover:border-teal hover:bg-teal-soft'
                  : 'cursor-not-allowed border-line/60 bg-line/25 text-muted/60 line-through'
              }`}
            >
              {holding === s.startsAt ? '…' : fmt.time(s.startsAt)}
            </button>
          ))}
        </div>
      )}

      {hold && (
        <IntakeModal
          hold={hold}
          doctor={doctor}
          onClose={() => { setHold(null); load(); }}
          onConfirmed={() => { setHold(null); onBooked(); }}
        />
      )}
    </section>
  );
}

/**
 * The symptom form is the reason the hold exists: it takes minutes to fill in,
 * and without a hold two patients could both complete it for the same slot and
 * one would lose the work.
 */
function IntakeModal({ hold, doctor, onClose, onConfirmed }: {
  hold: { appointmentId: string; startsAt: string; holdExpiresAt: string };
  doctor: DoctorSummary;
  onClose: () => void;
  onConfirmed: () => void;
}) {
  const [form, setForm] = useState({
    symptomsText: '', durationDays: '', severity: '5', existingMeds: '', allergies: '',
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [expired, setExpired] = useState(false);

  async function submit() {
    setBusy(true);
    setError('');
    try {
      await api.post(`/appointments/${hold.appointmentId}/intake`, {
        symptomsText: form.symptomsText,
        durationDays: form.durationDays ? Number(form.durationDays) : undefined,
        severity: Number(form.severity),
        existingMeds: form.existingMeds || undefined,
        allergies: form.allergies || undefined,
      });
      await api.post(`/appointments/${hold.appointmentId}/confirm`);
      onConfirmed();
    } catch (e) {
      const err = e as RequestError;
      setError(
        err.code === 'HOLD_EXPIRED'
          ? 'Your hold on this slot ran out. Close this and pick a time again.'
          : err.message,
      );
      if (err.code === 'HOLD_EXPIRED') setExpired(true);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal title="Tell the doctor what is wrong" onClose={onClose}>
      <div className="mb-4 rounded-lg bg-teal-soft px-3 py-2 text-sm">
        <strong>{doctor.name}</strong> · {fmt.dateTime(hold.startsAt)}
        <span className="ml-2 text-muted">
          held for <Countdown until={hold.holdExpiresAt} onExpire={() => setExpired(true)} />
        </span>
      </div>

      <div className="space-y-3">
        <Field label="Symptoms" hint="What you are feeling, and when it started. The doctor reads this before you arrive.">
          <textarea
            className="field min-h-28"
            value={form.symptomsText}
            onChange={(e) => setForm({ ...form, symptomsText: e.target.value })}
            placeholder="Sharp pain in my lower back when I stand up, started four days ago after lifting a heavy box."
          />
        </Field>

        <div className="grid grid-cols-2 gap-3">
          <Field label="Days so far">
            <input type="number" min={0} className="field" value={form.durationDays}
                   onChange={(e) => setForm({ ...form, durationDays: e.target.value })} />
          </Field>
          <Field label={`Severity — ${form.severity} of 10`}>
            <input type="range" min={1} max={10} className="w-full accent-[#0F5F5C]" value={form.severity}
                   onChange={(e) => setForm({ ...form, severity: e.target.value })} />
          </Field>
        </div>

        <Field label="Medicines you take">
          <input className="field" value={form.existingMeds}
                 onChange={(e) => setForm({ ...form, existingMeds: e.target.value })}
                 placeholder="Metformin 500mg twice a day" />
        </Field>
        <Field label="Allergies">
          <input className="field" value={form.allergies}
                 onChange={(e) => setForm({ ...form, allergies: e.target.value })}
                 placeholder="Penicillin" />
        </Field>

        <ErrorNote>{error}</ErrorNote>

        <div className="flex justify-end gap-2 pt-1">
          <button className="btn-ghost" onClick={onClose}>Cancel</button>
          <button
            className="btn-primary"
            disabled={busy || expired || form.symptomsText.trim().length < 10}
            onClick={submit}
          >
            {busy ? 'Confirming…' : 'Confirm appointment'}
          </button>
        </div>
      </div>
    </Modal>
  );
}

// ----------------------------------------------------------- appointments ---

function Appointments({ list, reload }: { list: AppointmentDto[]; reload: () => Promise<void> }) {
  const [open, setOpen] = useState<string | null>(null);

  if (!list.length) {
    return <Empty title="No appointments yet" hint="Find a doctor to book your first visit." />;
  }

  return (
    <div className="space-y-3">
      {list.map((a) => (
        <article key={a.id} className="card p-4">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <div className="flex items-center gap-2">
                <StateChip state={a.state} />
                {a.calendarSynced && <span className="chip bg-line/60 text-muted">in calendar</span>}
              </div>
              <h3 className="mt-2 font-semibold">{a.doctorName}</h3>
              <p className="text-sm text-muted">{a.specialisation}</p>
              <p className="mt-1 font-mono text-sm">{fmt.dateTime(a.startsAt)}</p>
              {a.cancelReason && <p className="mt-1 text-sm text-crimson">{a.cancelReason}</p>}
            </div>
            <div className="flex gap-2">
              {a.hasVisitNote && (
                <button className="btn-ghost" onClick={() => setOpen(a.id)}>Visit summary</button>
              )}
              {a.state === 'CONFIRMED' && <CancelButton id={a.id} reload={reload} />}
            </div>
          </div>
        </article>
      ))}
      {open && <SummaryModal appointmentId={open} onClose={() => setOpen(null)} />}
    </div>
  );
}

function CancelButton({ id, reload }: { id: string; reload: () => Promise<void> }) {
  const [busy, setBusy] = useState(false);
  return (
    <button
      className="btn-danger"
      disabled={busy}
      onClick={async () => {
        if (!confirm('Cancel this appointment? The slot opens up for someone else.')) return;
        setBusy(true);
        try {
          await api.post(`/appointments/${id}/cancel`, { reason: 'Cancelled by patient' });
          await reload();
        } finally { setBusy(false); }
      }}
    >
      {busy ? 'Cancelling…' : 'Cancel'}
    </button>
  );
}

function SummaryModal({ appointmentId, onClose }: { appointmentId: string; onClose: () => void }) {
  const [summary, setSummary] = useState<PostVisitSummaryDto | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    api.get<PostVisitSummaryDto>(`/patients/me/summaries/${appointmentId}`)
      .then(setSummary)
      .catch((e) => setError(e.message));
  }, [appointmentId]);

  return (
    <Modal title="After your visit" onClose={onClose}>
      <ErrorNote>{error}</ErrorNote>
      {!summary && !error ? <Spinner label="Loading your summary" /> : null}

      {summary && (
        <div className="space-y-4 text-sm">
          {summary.summaryText && <p className="leading-relaxed">{summary.summaryText}</p>}

          {summary.medicationSchedule.length > 0 && (
            <div>
              <span className="label">Medication</span>
              <ul className="mt-2 space-y-1.5">
                {summary.medicationSchedule.map((m, i) => (
                  <li key={i} className="rounded-lg bg-paper px-3 py-2">
                    <strong>{m.drug}</strong>
                    <span className="block text-muted">{m.when} · {m.duration}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {summary.followUpSteps.length > 0 && (
            <div>
              <span className="label">Next steps</span>
              <ul className="mt-2 list-disc space-y-1 pl-5">
                {summary.followUpSteps.map((s, i) => <li key={i}>{s}</li>)}
              </ul>
            </div>
          )}

          {summary.fallback && (
            <p className="rounded-lg bg-amber-soft px-3 py-2 text-xs text-amber">
              This was built straight from your prescription because the summary service was
              unavailable. Nothing is missing from your medication plan.
            </p>
          )}
        </div>
      )}
    </Modal>
  );
}
