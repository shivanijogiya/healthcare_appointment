import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { homeFor, useAuth } from '../lib/auth';
import { ErrorNote, Field } from '../components/ui';

const DEMO = [
  ['admin@clinic.test', 'Admin'],
  ['dr.rao@clinic.test', 'Doctor'],
  ['priya@example.test', 'Patient'],
];

export default function SignIn() {
  const { signIn, register } = useAuth();
  const navigate = useNavigate();
  const [mode, setMode] = useState<'in' | 'up'>('in');
  const [form, setForm] = useState({ email: '', password: '', name: '', phone: '' });
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true); setError('');
    try {
      const user = mode === 'in'
        ? await signIn(form.email, form.password)
        : await register({ email: form.email, password: form.password, name: form.name, phone: form.phone || undefined });
      navigate(homeFor(user));
    } catch (err) {
      setError((err as Error).message);
    } finally { setBusy(false); }
  }

  return (
    <div className="mx-auto flex min-h-[80vh] max-w-md flex-col justify-center px-4">
      <div className="mb-6">
        <span className="label text-teal">Meridian Family Clinic</span>
        <h1 className="mt-1 text-2xl font-semibold">
          {mode === 'in' ? 'Sign in' : 'Create your patient account'}
        </h1>
        <p className="mt-1 text-sm text-muted">
          {mode === 'in'
            ? 'Patients, doctors and clinic staff all sign in here.'
            : 'Booking takes about a minute once you are registered.'}
        </p>
      </div>

      <form onSubmit={submit} className="card space-y-3 p-5">
        {mode === 'up' && (
          <Field label="Full name">
            <input className="field" required value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })} />
          </Field>
        )}
        <Field label="Email">
          <input className="field" type="email" required autoComplete="username" value={form.email}
            onChange={(e) => setForm({ ...form, email: e.target.value })} />
        </Field>
        <Field label="Password" hint={mode === 'up' ? 'At least 8 characters, with a letter and a number.' : undefined}>
          <input className="field" type="password" required
            autoComplete={mode === 'in' ? 'current-password' : 'new-password'} value={form.password}
            onChange={(e) => setForm({ ...form, password: e.target.value })} />
        </Field>

        <ErrorNote>{error}</ErrorNote>

        <button className="btn-primary w-full" disabled={busy}>
          {busy ? 'Just a moment…' : mode === 'in' ? 'Sign in' : 'Create account'}
        </button>

        <button type="button" className="w-full text-sm text-muted hover:text-ink"
          onClick={() => { setMode(mode === 'in' ? 'up' : 'in'); setError(''); }}>
          {mode === 'in' ? 'New patient? Create an account' : 'Already registered? Sign in'}
        </button>
      </form>

      {mode === 'in' && (
        <div className="mt-5">
          <span className="label">Demo accounts — password Passw0rd!</span>
          <div className="mt-2 flex flex-wrap gap-2">
            {DEMO.map(([email, role]) => (
              <button key={email}
                onClick={() => setForm({ ...form, email, password: 'Passw0rd!' })}
                className="chip border border-line px-3 py-1 text-muted hover:border-teal hover:text-teal">
                {role}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
