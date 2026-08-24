import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import type { AuthResponse, AuthUser } from '@ham/types';
import { api, session } from './api';

interface AuthState {
  user: AuthUser | null;
  loading: boolean;
  signIn: (email: string, password: string) => Promise<AuthUser>;
  register: (body: Record<string, unknown>) => Promise<AuthUser>;
  signOut: () => void;
}

const Ctx = createContext<AuthState>(null!);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [loading, setLoading] = useState(true);

  // Restore the session on load so a refresh does not sign the user out.
  useEffect(() => {
    if (!session.read()) { setLoading(false); return; }
    api.get<AuthUser>('/auth/me')
      .then(setUser)
      .catch(() => session.clear())
      .finally(() => setLoading(false));
  }, []);

  const value = useMemo<AuthState>(() => ({
    user,
    loading,
    async signIn(email, password) {
      const res = await api.post<AuthResponse>('/auth/login', { email, password });
      session.write(res);
      setUser(res.user);
      return res.user;
    },
    async register(body) {
      const res = await api.post<AuthResponse>('/auth/register', body);
      session.write(res);
      setUser(res.user);
      return res.user;
    },
    signOut() { session.clear(); setUser(null); },
  }), [user, loading]);

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export const useAuth = () => useContext(Ctx);

/** Where each role lands after signing in. */
export function homeFor(user: AuthUser): string {
  return user.role === 'ADMIN' ? '/admin' : user.role === 'DOCTOR' ? '/doctor' : '/patient';
}
