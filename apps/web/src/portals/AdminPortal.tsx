import { useCallback, useEffect, useState } from 'react';
import type { DoctorSummary } from '@ham/types';
import { api } from '../lib/api';
import * as fmt from '../lib/format';
import { Empty, ErrorNote, Field, Modal, Spinner, StateChip } from '../components/ui';

type Tab = 'overview' | 'doctors' | 'notifications' | 'audit';

export default function AdminPortal() {
  const [tab, setTab] = useState<Tab>('overview');
  const tabs: [Tab, string][] = [
    ['overview', 'Overview'],
    ['doctors', 'Doctors'],
    ['notifications', 'Notifications'],
    ['audit', 'Audit'],
  ];

  return (
    <div className="mx-auto max-w-6xl px-4 py-8">
      <nav className="mb-6 flex flex-wrap gap-1">
        {tabs.map(([id, label]) => (
          <button key={id} onClick={() => setTab(id)}
            className={`rounded-lg px-3 py-1.5 text-sm font-medium ${tab === id ? 'bg-ink text-white' : 'text-muted hover:bg-line/40'}`}>
            {label}
          </button>
        ))}
      </nav>
      {tab === 'overview' && <Overview />}
      {tab === 'doctors' && <Doctors />}
      {tab === 'notifications' && <Notifications />}
      {tab === 'audit' && <Audit />}
    </div>
  );
}

// --------------------------------------------------------------- overview ---

function Overview() {
  const [data, setData] = useState<any>(null);
  const [health, setHealth] = useState<any>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    Promise.all([api.get<any>('/admin/overview'), api.get<any>('/health')])
      .then(([o, h]) => { setData(o); setHealth(h); })
      .catch((e) => setError(e.message));
  }, []);

  if (error) return <ErrorNote>{error}</ErrorNote>;
  if (!data) return <Spinner label="Loading clinic status" />;

  const dead = data.notifications?.DEAD ?? 0;
  const llmFailed = (data.preVisitSummaries?.FAILED ?? 0) + (data.postVisitSummaries?.FAILED ?? 0);

  return (
    <section className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Stat label="Doctors" value={data.doctors} />
        <Stat label="Patients" value={data.patients} />
        <Stat label="Confirmed" value={data.appointments?.CONFIRMED ?? 0} />
        <Stat label="Completed" value={data.appointments?.COMPLETED ?? 0} />
      </div>

      {(dead > 0 || llmFailed > 0) && (
        <div className="card border-amber/30 bg-amber-soft p-4">
          <span className="label text-amber">Needs attention</span>
          <ul className="mt-2 space-y-1 text-sm text-amber">
            {dead > 0 && <li>{dead} notification(s) gave up after every retry. Retry them from the Notifications tab.</li>}
            {llmFailed > 0 && <li>{llmFailed} AI summary(ies) failed. Patients and doctors saw the fallback content instead.</li>}
          </ul>
        </div>
      )}

      <div className="grid gap-3 sm:grid-cols-2">
        <div className="card p-4">
          <span className="label">Notifications</span>
          <Breakdown data={data.notifications} />
        </div>
        <div className="card p-4">
          <span className="label">AI summaries</span>
          <div className="mt-2 text-sm">
            <p className="text-muted">Pre-visit</p>
            <Breakdown data={data.preVisitSummaries} />
            <p className="mt-2 text-muted">Post-visit</p>
            <Breakdown data={data.postVisitSummaries} />
          </div>
        </div>
      </div>

      {health && (
        <div className="card p-4">
          <span className="label">Dependencies</span>
          <dl className="mt-2 grid gap-2 text-sm sm:grid-cols-4">
            <Dep name="Database" value={health.database} />
            <Dep name="Queue" value={health.redis} />
            <Dep name="Model" value={`${health.llm?.provider} · breaker ${health.llm?.state}`} />
            <Dep name="Calendar" value={health.calendar?.configured ? 'configured' : 'not configured'} />
          </dl>
        </div>
      )}
    </section>
  );
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div className="card p-4">
      <span className="label">{label}</span>
      <p className="mt-1 font-mono text-2xl font-semibold tabular-nums">{value}</p>
    </div>
  );
}

function Breakdown({ data }: { data?: Record<string, number> }) {
  const entries = Object.entries(data ?? {});
  if (!entries.length) return <p className="mt-1 text-sm text-muted">Nothing yet.</p>;
  return (
    <ul className="mt-1.5 space-y-1 font-mono text-xs">
      {entries.map(([k, v]) => (
        <li key={k} className="flex justify-between">
          <span className="text-muted">{k}</span><span className="tabular-nums">{v}</span>
        </li>
      ))}
    </ul>
  );
}

function Dep({ name, value }: { name: string; value: string }) {
  const ok = value === 'up' || value?.includes('closed') || value === 'configured';
  return (
    <div>
      <dt className="label">{name}</dt>
      <dd className={`font-mono text-xs ${ok ? 'text-teal' : 'text-muted'}`}>{value}</dd>
    </div>
  );
}

// ---------------------------------------------------------------- doctors ---

function Doctors() {
  const [list, setList] = useState<DoctorSummary[] | null>(null);
  const [error, setError] = useState('');
  const [creating, setCreating] = useState(false);
  const [hours, setHours] = useState<DoctorSummary | null>(null);

  const load = useCallback(async () => {
    try { setList(await api.get<DoctorSummary[]>('/doctors')); }
    catch (e) { setError((e as Error).message); }
  }, []);
  useEffect(() => { load(); }, [load]);

  return (
    <section>
      <div className="mb-4 flex items-center justify-between">
        <h2 className="font-semibold">Doctor profiles</h2>
        <button className="btn-primary" onClick={() => setCreating(true)}>Add a doctor</button>
      </div>
      <ErrorNote onRetry={load}>{error}</ErrorNote>
      {!list ? <Spinner /> : (
        <div className="space-y-2">
          {list.map((d) => (
            <div key={d.id} className="card flex flex-wrap items-center gap-3 p-4">
              <div className="flex-1">
                <span className="label">{d.specialisation}</span>
                <p className="font-medium">{d.name}</p>
                <p className="font-mono text-xs text-muted">
                  {d.email} · {d.slotDurationMin} min slots
                  {d.calendarConnected ? ' · calendar connected' : ''}
                </p>
              </div>
              <button className="btn-ghost" onClick={() => setHours(d)}>Working hours</button>
            </div>
          ))}
        </div>
      )}
      {creating && <CreateDoctor onClose={() => setCreating(false)} onCreated={() => { setCreating(false); load(); }} />}
      {hours && <AvailabilityEditor doctor={hours} onClose={() => setHours(null)} />}
    </section>
  );
}

function CreateDoctor({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {
  const [form, setForm] = useState({
    email: '', password: '', name: '', specialisation: '', qualification: '',
    slotDurationMin: 15, consultFee: '', bio: '',
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function submit() {
    setBusy(true); setError('');
    try {
      await api.post('/doctors', {
        ...form,
        consultFee: form.consultFee ? Number(form.consultFee) : undefined,
        qualification: form.qualification || undefined,
        bio: form.bio || undefined,
      });
      onCreated();
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  }

  return (
    <Modal title="Add a doctor" onClose={onClose}>
      <div className="space-y-3">
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Name"><input className="field" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></Field>
          <Field label="Specialisation"><input className="field" value={form.specialisation} onChange={(e) => setForm({ ...form, specialisation: e.target.value })} /></Field>
          <Field label="Email"><input className="field" type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} /></Field>
          <Field label="Temporary password" hint="At least 8 characters, with a letter and a number.">
            <input className="field" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} />
          </Field>
          <Field label="Qualification"><input className="field" value={form.qualification} onChange={(e) => setForm({ ...form, qualification: e.target.value })} /></Field>
          <Field label="Appointment length" hint="Minutes per slot.">
            <input className="field" type="number" min={5} max={120} value={form.slotDurationMin}
              onChange={(e) => setForm({ ...form, slotDurationMin: Number(e.target.value) })} />
          </Field>
        </div>
        <ErrorNote>{error}</ErrorNote>
        <div className="flex justify-end gap-2">
          <button className="btn-ghost" onClick={onClose}>Cancel</button>
          <button className="btn-primary" disabled={busy || !form.email || !form.name || !form.specialisation} onClick={submit}>
            {busy ? 'Creating…' : 'Create doctor'}
          </button>
        </div>
      </div>
    </Modal>
  );
}

const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

function AvailabilityEditor({ doctor, onClose }: { doctor: DoctorSummary; onClose: () => void }) {
  const [windows, setWindows] = useState<{ weekday: number; startTime: string; endTime: string }[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    api.get<any[]>(`/doctors/${doctor.id}/availability`)
      .then((rows) => setWindows(rows.map((r) => ({ weekday: r.weekday, startTime: r.startTime, endTime: r.endTime }))))
      .catch((e) => setError(e.message));
  }, [doctor.id]);

  async function save() {
    setBusy(true); setError(''); setSaved(false);
    try {
      await api.put(`/doctors/${doctor.id}/availability`, { windows });
      setSaved(true);
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  }

  return (
    <Modal title={`Working hours — ${doctor.name}`} onClose={onClose}>
      <p className="mb-3 text-sm text-muted">
        Changing these takes effect immediately for new bookings. Appointments already booked are never cancelled by an hours change.
      </p>
      <div className="space-y-2">
        {windows.map((w, i) => (
          <div key={i} className="grid grid-cols-12 items-center gap-1.5">
            <select className="field col-span-5" value={w.weekday}
              onChange={(e) => setWindows(windows.map((x, idx) => idx === i ? { ...x, weekday: Number(e.target.value) } : x))}>
              {DAY_NAMES.map((d, idx) => <option key={idx} value={idx}>{d}</option>)}
            </select>
            <input type="time" className="field col-span-3" value={w.startTime}
              onChange={(e) => setWindows(windows.map((x, idx) => idx === i ? { ...x, startTime: e.target.value } : x))} />
            <input type="time" className="field col-span-3" value={w.endTime}
              onChange={(e) => setWindows(windows.map((x, idx) => idx === i ? { ...x, endTime: e.target.value } : x))} />
            <button className="col-span-1 text-muted hover:text-crimson" aria-label="Remove"
              onClick={() => setWindows(windows.filter((_, idx) => idx !== i))}>✕</button>
          </div>
        ))}
      </div>
      <button className="mt-2 text-sm text-teal underline underline-offset-2"
        onClick={() => setWindows([...windows, { weekday: 1, startTime: '09:00', endTime: '13:00' }])}>
        Add a session
      </button>
      <ErrorNote>{error}</ErrorNote>
      {saved && <p className="mt-2 text-sm text-teal">Working hours saved.</p>}
      <div className="mt-4 flex justify-end gap-2">
        <button className="btn-ghost" onClick={onClose}>Close</button>
        <button className="btn-primary" disabled={busy} onClick={save}>{busy ? 'Saving…' : 'Save hours'}</button>
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------- notifications ---

const STATES = ['', 'PENDING', 'SENT', 'DEAD'] as const;

/**
 * The notification console. A DEAD row is a message a real person never
 * received, so it is surfaced with the underlying error and a one-click retry
 * rather than being left to rot in a table.
 */
function Notifications() {
  const [state, setState] = useState<string>('');
  const [rows, setRows] = useState<any[] | null>(null);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    setRows(null);
    try { setRows(await api.get<any[]>(`/admin/notifications${state ? `?state=${state}` : ''}`)); }
    catch (e) { setError((e as Error).message); }
  }, [state]);
  useEffect(() => { load(); }, [load]);

  async function retry(id: string) {
    await api.post(`/admin/notifications/${id}/retry`);
    load();
  }

  return (
    <section>
      <div className="mb-4 flex gap-2">
        {STATES.map((s) => (
          <button key={s || 'all'} onClick={() => setState(s)}
            className={`chip border px-3 py-1 ${state === s ? 'border-teal bg-teal-soft text-teal' : 'border-line text-muted'}`}>
            {s || 'All'}
          </button>
        ))}
      </div>
      <ErrorNote onRetry={load}>{error}</ErrorNote>
      {!rows ? <Spinner /> : rows.length === 0 ? (
        <Empty title="Nothing here" hint="Notifications appear as appointments are booked and changed." />
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="border-b border-line text-left">
              <tr className="label">
                <th className="py-2">Type</th><th>Recipient</th><th>State</th>
                <th>Attempts</th><th>Scheduled</th><th></th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} className="border-b border-line/60">
                  <td className="py-2 font-mono text-xs">{r.type}</td>
                  <td className="text-muted">{r.recipient_email}</td>
                  <td><StateChip state={r.state} /></td>
                  <td className="font-mono text-xs tabular-nums">{r.attempts}</td>
                  <td className="font-mono text-xs text-muted">{fmt.dateTime(r.scheduled_for)}</td>
                  <td className="text-right">
                    {r.state === 'DEAD' && (
                      <button className="btn-ghost !py-1 !text-xs" onClick={() => retry(r.id)}>Retry</button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {rows.some((r) => r.last_error) && (
            <div className="mt-4">
              <span className="label">Recent errors</span>
              <ul className="mt-1 space-y-1 font-mono text-xs text-crimson">
                {rows.filter((r) => r.last_error).slice(0, 5).map((r) => (
                  <li key={r.id}>{r.type}: {r.last_error}</li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </section>
  );
}

// ------------------------------------------------------------------ audit ---

function Audit() {
  const [rows, setRows] = useState<any[] | null>(null);
  useEffect(() => { api.get<any[]>('/admin/audit').then(setRows).catch(() => setRows([])); }, []);
  if (!rows) return <Spinner />;
  if (!rows.length) return <Empty title="No activity recorded yet" />;
  return (
    <ul className="space-y-1.5">
      {rows.map((r) => (
        <li key={r.id} className="card flex flex-wrap items-center gap-3 px-4 py-2 text-sm">
          <span className="font-mono text-xs text-teal">{r.action}</span>
          <span className="text-muted">{r.actorName ?? 'system'}</span>
          <span className="ml-auto font-mono text-xs text-muted">{fmt.dateTime(r.createdAt)}</span>
        </li>
      ))}
    </ul>
  );
}
