import { useEffect, useState, type ReactNode } from 'react';
import type { Urgency } from '@ham/types';

export function Spinner({ label = 'Loading' }: { label?: string }) {
  return (
    <div className="flex items-center gap-2 py-8 text-sm text-muted" role="status">
      <span className="h-3 w-3 animate-spin rounded-full border-2 border-line border-t-teal" />
      {label}
    </div>
  );
}

/** Errors say what happened and what to do, never just "something went wrong". */
export function ErrorNote({ children, onRetry }: { children: ReactNode; onRetry?: () => void }) {
  if (!children) return null;
  return (
    <div className="rounded-lg border border-crimson/25 bg-crimson-soft px-3 py-2 text-sm text-crimson">
      {children}
      {onRetry && (
        <button onClick={onRetry} className="ml-2 underline underline-offset-2">Try again</button>
      )}
    </div>
  );
}

export function Empty({ title, hint }: { title: string; hint?: string }) {
  return (
    <div className="rounded-lg border border-dashed border-line px-4 py-10 text-center">
      <p className="text-sm font-medium">{title}</p>
      {hint && <p className="mt-1 text-sm text-muted">{hint}</p>}
    </div>
  );
}

export function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <label className="block">
      <span className="label">{label}</span>
      <div className="mt-1.5">{children}</div>
      {hint && <span className="mt-1 block text-xs text-muted">{hint}</span>}
    </label>
  );
}

const STATE_STYLES: Record<string, string> = {
  CONFIRMED: 'bg-teal-soft text-teal',
  HELD:      'bg-amber-soft text-amber',
  COMPLETED: 'bg-line/60 text-muted',
  CANCELLED: 'bg-crimson-soft text-crimson',
  NO_SHOW:   'bg-crimson-soft text-crimson',
};

export function StateChip({ state }: { state: string }) {
  return <span className={`chip ${STATE_STYLES[state] ?? 'bg-line/60 text-muted'}`}>{state.replace('_', ' ')}</span>;
}

const URGENCY_STYLES: Record<Urgency, string> = {
  HIGH:   'bg-crimson text-white',
  MEDIUM: 'bg-amber text-white',
  LOW:    'bg-teal text-white',
};

export function UrgencyChip({ urgency }: { urgency: Urgency }) {
  return <span className={`chip ${URGENCY_STYLES[urgency]}`}>{urgency} urgency</span>;
}

/** Live countdown on a slot hold, so the deadline is never a surprise. */
export function Countdown({ until, onExpire }: { until: string; onExpire?: () => void }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  const ms = new Date(until).getTime() - now;
  useEffect(() => { if (ms <= 0) onExpire?.(); }, [ms <= 0]);
  if (ms <= 0) return <span className="font-mono text-crimson">expired</span>;
  const m = Math.floor(ms / 60_000);
  const s = Math.floor((ms % 60_000) / 1000);
  return <span className="font-mono tabular-nums">{m}:{String(s).padStart(2, '0')}</span>;
}

export function Modal({ title, children, onClose }: { title: string; children: ReactNode; onClose: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-ink/30 p-4 sm:p-8"
         role="dialog" aria-modal="true" aria-label={title}>
      <div className="card w-full max-w-lg p-5">
        <div className="mb-4 flex items-start justify-between gap-4">
          <h2 className="text-lg font-semibold">{title}</h2>
          <button onClick={onClose} className="text-muted hover:text-ink" aria-label="Close">✕</button>
        </div>
        {children}
      </div>
    </div>
  );
}
