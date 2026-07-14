// Thin API client with automatic refresh-token rotation.
const BASE = '/api';

let accessToken: string | null = localStorage.getItem('lt_access');
let refreshToken: string | null = localStorage.getItem('lt_refresh');

export function setTokens(access: string | null, refresh: string | null) {
  accessToken = access;
  refreshToken = refresh;
  if (access) localStorage.setItem('lt_access', access);
  else localStorage.removeItem('lt_access');
  if (refresh) localStorage.setItem('lt_refresh', refresh);
  else localStorage.removeItem('lt_refresh');
}

export function hasSession() {
  return !!refreshToken;
}

export class ApiError extends Error {
  status: number;
  body: unknown;
  constructor(status: number, body: unknown) {
    super(typeof body === 'object' && body && 'message' in (body as object)
      ? String((body as { message: unknown }).message)
      : `Request failed (${status})`);
    this.status = status;
    this.body = body;
  }
}

async function rawRequest(method: string, path: string, body?: unknown): Promise<Response> {
  return fetch(`${BASE}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

// Refresh tokens are single-use (rotated server-side), so concurrent 401s must
// share ONE refresh call — otherwise the loser invalidates the whole session.
let refreshInFlight: Promise<RefreshResult | null> | null = null;

export interface RefreshResult {
  user: { id: number; name: string; email: string; roleId: number; roleCode: string; roleName: string };
  accessToken: string;
  refreshToken: string;
}

export function refreshSession(): Promise<RefreshResult | null> {
  if (!refreshInFlight) {
    refreshInFlight = (async () => {
      if (!refreshToken) return null;
      try {
        const res = await fetch(`${BASE}/auth/refresh`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ refreshToken }),
        });
        if (!res.ok) {
          setTokens(null, null);
          return null;
        }
        const data = (await res.json()) as RefreshResult;
        setTokens(data.accessToken, data.refreshToken);
        return data;
      } catch {
        return null;
      } finally {
        setTimeout(() => (refreshInFlight = null), 0);
      }
    })();
  }
  return refreshInFlight;
}

async function tryRefresh(): Promise<boolean> {
  return (await refreshSession()) !== null;
}

export async function api<T = unknown>(method: string, path: string, body?: unknown): Promise<T> {
  let res = await rawRequest(method, path, body);
  if (res.status === 401 && (await tryRefresh())) {
    res = await rawRequest(method, path, body);
  }
  if (res.status === 503) {
    throw new ApiError(503, { message: 'Service unavailable' });
  }
  const text = await res.text();
  const json = text ? JSON.parse(text) : null;
  if (!res.ok) throw new ApiError(res.status, json);
  return json as T;
}

export const get = <T = unknown>(path: string) => api<T>('GET', path);
export const post = <T = unknown>(path: string, body?: unknown) => api<T>('POST', path, body);
export const patch = <T = unknown>(path: string, body?: unknown) => api<T>('PATCH', path, body);
