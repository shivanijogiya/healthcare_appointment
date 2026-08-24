import type { ApiError } from '@ham/types';

const BASE = import.meta.env.VITE_API_URL ?? '/api';

export class RequestError extends Error {
  constructor(readonly status: number, readonly payload: ApiError) {
    super(payload?.message ?? 'Request failed');
  }
  get code() { return this.payload?.code; }
}

interface Tokens { accessToken: string; refreshToken: string }

const KEY = 'ham.session';

export const session = {
  read(): Tokens | null {
    try { return JSON.parse(sessionStorage.getItem(KEY) ?? 'null'); } catch { return null; }
  },
  write(t: Tokens) { sessionStorage.setItem(KEY, JSON.stringify(t)); },
  clear() { sessionStorage.removeItem(KEY); },
};

let refreshing: Promise<boolean> | null = null;

/**
 * Transparently rotates an expired access token once before giving up, so the
 * 15-minute expiry never surfaces to the user as a random failure.
 */
async function refresh(): Promise<boolean> {
  const current = session.read();
  if (!current?.refreshToken) return false;
  refreshing ??= (async () => {
    try {
      const res = await fetch(`${BASE}/auth/refresh`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ refreshToken: current.refreshToken }),
      });
      if (!res.ok) { session.clear(); return false; }
      const data = await res.json();
      session.write({ accessToken: data.accessToken, refreshToken: data.refreshToken });
      return true;
    } finally {
      setTimeout(() => { refreshing = null; }, 0);
    }
  })();
  return refreshing;
}

export async function request<T>(
  path: string,
  options: { method?: string; body?: unknown; headers?: Record<string, string>; retry?: boolean } = {},
): Promise<T> {
  const { method = 'GET', body, headers = {}, retry = true } = options;
  const token = session.read()?.accessToken;

  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  if (res.status === 401 && retry && (await refresh())) {
    return request<T>(path, { ...options, retry: false });
  }

  const text = await res.text();
  const payload = text ? JSON.parse(text) : null;
  if (!res.ok) throw new RequestError(res.status, payload);
  return payload as T;
}

export const api = {
  get:  <T>(p: string) => request<T>(p),
  post: <T>(p: string, body?: unknown, headers?: Record<string, string>) =>
    request<T>(p, { method: 'POST', body, headers }),
  put:  <T>(p: string, body?: unknown) => request<T>(p, { method: 'PUT', body }),
  patch:<T>(p: string, body?: unknown) => request<T>(p, { method: 'PATCH', body }),
  del:  <T>(p: string) => request<T>(p, { method: 'DELETE' }),
};
