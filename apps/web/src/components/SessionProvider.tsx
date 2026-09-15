'use client';

import type { SessionUser } from '@imob/contracts';
import { useRouter } from 'next/navigation';
import { createContext, useCallback, useContext, useEffect, useState } from 'react';
import { apiFetch } from '@/lib/api';

interface SessionValue {
  user: SessionUser;
  logout: () => Promise<void>;
}

const SessionContext = createContext<SessionValue | null>(null);

export function useSession(): SessionValue {
  const value = useContext(SessionContext);
  if (!value) throw new Error('useSession fora de SessionProvider');
  return value;
}

export function SessionProvider({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const [user, setUser] = useState<SessionUser | null>(null);

  useEffect(() => {
    // apiFetch ja tenta renovar a sessao e manda para /login se nao conseguir.
    apiFetch<{ user: SessionUser }>('/auth/me')
      .then(({ user: current }) => setUser(current))
      .catch(() => undefined);
  }, []);

  const logout = useCallback(async () => {
    await apiFetch('/auth/logout', { method: 'POST' }).catch(() => undefined);
    router.replace('/login');
  }, [router]);

  if (!user) {
    return <div className="boot" aria-busy="true" />;
  }

  return <SessionContext.Provider value={{ user, logout }}>{children}</SessionContext.Provider>;
}
