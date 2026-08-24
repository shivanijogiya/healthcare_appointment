const OFFSET_MIN = Number(import.meta.env.VITE_CLINIC_OFFSET_MINUTES ?? 330);

/** Renders an instant in clinic-local time, matching what the API emails say. */
function shift(iso: string): Date {
  return new Date(new Date(iso).getTime() + OFFSET_MIN * 60_000);
}

export function time(iso: string): string {
  const d = shift(iso);
  const h = d.getUTCHours();
  const m = d.getUTCMinutes();
  const suffix = h < 12 ? 'am' : 'pm';
  return `${h % 12 === 0 ? 12 : h % 12}:${String(m).padStart(2, '0')}${suffix}`;
}

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export function date(iso: string): string {
  const d = shift(iso);
  return `${DAYS[d.getUTCDay()]} ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`;
}

export function dateTime(iso: string): string { return `${date(iso)}, ${time(iso)}`; }

/** "YYYY-MM-DD" for today in clinic-local terms. */
export function todayLocal(): string {
  return new Date(Date.now() + OFFSET_MIN * 60_000).toISOString().slice(0, 10);
}

export function addDays(isoDate: string, days: number): string {
  return new Date(new Date(`${isoDate}T00:00:00Z`).getTime() + days * 86_400_000)
    .toISOString().slice(0, 10);
}

export function longDate(isoDate: string): string {
  const d = new Date(`${isoDate}T00:00:00Z`);
  return `${DAYS[d.getUTCDay()]} ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

export function countdown(iso: string): string {
  const ms = new Date(iso).getTime() - Date.now();
  if (ms <= 0) return 'expired';
  const m = Math.floor(ms / 60_000);
  const s = Math.floor((ms % 60_000) / 1000);
  return `${m}:${String(s).padStart(2, '0')}`;
}
