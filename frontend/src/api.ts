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
  return !!refreshToken || inBatchMode();
}

// ── Quick batch-session mode ──────────────────────────────────
// The original login's tokens are parked while a colleague works as
// themselves on this screen; expiry restores the original login.

export interface BatchInfo {
  user: { id: number; name: string; email: string; roleId: number; roleCode: string; roleName: string };
  expiresAt: string;
}

export function inBatchMode(): boolean {
  return localStorage.getItem('lt_batch') === '1';
}

export function batchInfo(): BatchInfo | null {
  if (!inBatchMode()) return null;
  try {
    return {
      user: JSON.parse(localStorage.getItem('lt_batch_user') ?? ''),
      expiresAt: localStorage.getItem('lt_batch_exp') ?? '',
    };
  } catch {
    return null;
  }
}

export function startBatchMode(data: { accessToken: string; expiresAt: string; user: BatchInfo['user'] }) {
  localStorage.setItem('lt_backup_access', localStorage.getItem('lt_access') ?? '');
  localStorage.setItem('lt_backup_refresh', localStorage.getItem('lt_refresh') ?? '');
  localStorage.setItem('lt_batch', '1');
  localStorage.setItem('lt_batch_exp', data.expiresAt);
  localStorage.setItem('lt_batch_user', JSON.stringify(data.user));
  setTokens(data.accessToken, null);
}

/** Ends the quick session (best effort server-side) and restores the original login. */
export async function endBatchMode(): Promise<void> {
  try {
    await rawRequest('POST', '/auth/batch-session/end');
  } catch {
    /* token may already be expired — fine */
  }
  const access = localStorage.getItem('lt_backup_access') || null;
  const refresh = localStorage.getItem('lt_backup_refresh') || null;
  localStorage.removeItem('lt_batch');
  localStorage.removeItem('lt_batch_exp');
  localStorage.removeItem('lt_batch_user');
  localStorage.removeItem('lt_backup_access');
  localStorage.removeItem('lt_backup_refresh');
  setTokens(access, refresh);
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
      if (inBatchMode()) return null; // quick sessions have no refresh by design
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
  if (res.status === 401 && inBatchMode()) {
    // Quick session expired server-side → restore the original login.
    await endBatchMode();
    window.location.reload();
    throw new ApiError(401, { message: 'Session expired — restoring previous login' });
  }
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
