import { Link, useNavigate } from 'react-router-dom';
import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { homeFor, useAuth } from '../lib/auth';
import { api } from '../lib/api';

/** Chrome shared by all three portals: identity, calendar link, sign out. */
export default function Shell({ children }: { children: ReactNode }) {
  const { user, signOut } = useAuth();
  const navigate = useNavigate();
  const [calendar, setCalendar] = useState<{ available: boolean; connected: boolean } | null>(null);

  useEffect(() => {
    if (!user || user.role === 'ADMIN') return;
    api.get<any>('/calendar/status').then(setCalendar).catch(() => {});
  }, [user]);

  async function connectCalendar() {
    try {
      const { url } = await api.get<{ url: string }>('/calendar/connect');
      window.location.href = url;
    } catch {
      alert('Google Calendar is not configured on this server. See docs/google-calendar-setup.md.');
    }
  }

  return (
    <div className="min-h-screen">
      <header className="border-b border-line bg-card">
        <div className="mx-auto flex max-w-6xl items-center gap-4 px-4 py-3">
          <Link to={user ? homeFor(user) : '/'} className="label text-teal">Meridian Clinic</Link>
          <div className="ml-auto flex items-center gap-3">
            {calendar?.available && !calendar.connected && (
              <button onClick={connectCalendar} className="text-sm text-muted hover:text-ink">
                Connect Google Calendar
              </button>
            )}
            {calendar?.connected && <span className="chip bg-teal-soft text-teal">calendar on</span>}
            {user && (
              <>
                <span className="hidden text-sm sm:inline">
                  {user.name} <span className="text-muted">· {user.role.toLowerCase()}</span>
                </span>
                <button className="btn-ghost !py-1.5" onClick={() => { signOut(); navigate('/'); }}>
                  Sign out
                </button>
              </>
            )}
          </div>
        </div>
      </header>
      <main>{children}</main>
    </div>
  );
}
