import { createContext, useCallback, useContext, useEffect, useState } from 'react';
import { get, hasSession, post, refreshSession, setTokens } from './api';

export interface User {
  id: number;
  name: string;
  email: string;
  roleId: number;
  roleCode: string;
  roleName: string;
}

export type PermMap = Record<string, { allowed: boolean; scope: 'ALL' | 'OWN' | 'ASSIGNED' | 'VIEW' }>;

interface AuthCtx {
  user: User | null;
  perms: PermMap;
  loading: boolean;
  can: (key: string) => boolean;
  scope: (key: string) => string | null;
  login: (email: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
  refreshPerms: () => Promise<void>;
}

const Ctx = createContext<AuthCtx>(null as never);
export const useAuth = () => useContext(Ctx);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [perms, setPerms] = useState<PermMap>({});
  const [loading, setLoading] = useState(true);

  const loadPerms = useCallback(async () => {
    setPerms(await get<PermMap>('/permissions/me'));
  }, []);

  useEffect(() => {
    (async () => {
      if (!hasSession()) {
        setLoading(false);
        return;
      }
      try {
        const data = await refreshSession();
        if (data) {
          setPerms(await get<PermMap>('/permissions/me'));
          setUser(data.user);
        }
      } catch {
        setTokens(null, null);
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  const login = async (email: string, password: string) => {
    const data = await post<{ user: User; accessToken: string; refreshToken: string }>(
      '/auth/login',
      { email, password },
    );
    setTokens(data.accessToken, data.refreshToken);
    await loadPerms(); // perms must be in place before the first authed render
    setUser(data.user);
  };

  const logout = async () => {
    try {
      await post('/auth/logout');
    } catch {
      /* session may already be gone */
    }
    setTokens(null, null);
    setUser(null);
    setPerms({});
  };

  const can = (key: string) => perms[key]?.allowed === true;
  const scope = (key: string) => (perms[key]?.allowed ? perms[key].scope : null);

  return (
    <Ctx.Provider value={{ user, perms, loading, can, scope, login, logout, refreshPerms: loadPerms }}>
      {children}
    </Ctx.Provider>
  );
}
