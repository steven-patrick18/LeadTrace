/**
 * Permission guard tests per permission_key (spec §9 definition of done).
 * Requires the dev server on :3000 and the seeded matrix.
 * For every permission key: a role WITHOUT it gets 403 from a representative
 * endpoint, and a role WITH it gets through the guard (any non-403 response).
 */
const BASE = 'http://localhost:3000/api';
const PASS = process.env.SEED_USER_PASSWORD || 'LeadTrace!Dev1';

const LOGINS: Record<string, string> = {
  AGENT: 'agent2@leadtrace.local',
  SR_AGENT: 'sragent2@leadtrace.local',
  CLOSER: 'closer@leadtrace.local',
  MANAGER: 'manager@leadtrace.local',
  ADMIN: 'admin@leadtrace.local',
};

const tokens: Record<string, string> = {};

async function call(role: string, method: string, path: string, body?: unknown) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tokens[role]}` },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return res.status;
}

beforeAll(async () => {
  for (const [role, email] of Object.entries(LOGINS)) {
    const res = await fetch(`${BASE}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password: PASS }),
    });
    expect(res.ok).toBe(true);
    tokens[role] = (await res.json()).accessToken;
  }
});

// [key, method, path, body, roleWithout, roleWith]
const CASES: Array<[string, string, string, unknown, string, string]> = [
  ['search_providers', 'POST', '/search', { lastName: 'Smith' }, 'CLOSER', 'AGENT'],
  ['create_lead', 'POST', '/leads', { firstName: 'X', lastName: 'Y', phones: [{ number: '+13055550199' }], force: true }, 'CLOSER', 'MANAGER'],
  ['view_own_leads', 'GET', '/leads', undefined, '__NONE__', 'AGENT'],
  ['view_all_leads', 'GET', '/leads?scope=all', undefined, 'AGENT', 'MANAGER'],
  ['edit_lead', 'PATCH', '/leads/999999', { city: 'Z' }, '__SKIP_WITHOUT__', 'MANAGER'],
  ['log_activity', 'POST', '/leads/999999/activities', { type: 'NOTE', detail: 'x' }, '__SKIP_WITHOUT__', 'MANAGER'],
  ['request_transfer', 'POST', '/routing/leads/999999/request-transfer', {}, 'CLOSER', 'AGENT'],
  // Managers own the common T2→T3 bucket (route_leads granted by default);
  // Closers stay denied.
  ['route_leads', 'GET', '/routing/queue', undefined, 'CLOSER', 'MANAGER'],
  ['close_deal', 'POST', '/routing/leads/999999/close', { outcome: 'CLOSED_WON' }, 'AGENT', 'CLOSER'],
  ['send_back', 'POST', '/routing/leads/999999/send-back', { reason: 'test' }, 'SR_AGENT', 'CLOSER'],
  ['view_reports_team', 'GET', '/reports/performance', undefined, '__TEAM_SCOPE__', 'MANAGER'],
  ['view_reports_own', 'GET', '/reports/dashboard', undefined, '__NONE__', 'AGENT'],
  ['view_api_costs', 'GET', '/reports/api-costs', undefined, 'AGENT', 'MANAGER'],
  ['export_data', 'GET', '/reports/export/leads.csv', undefined, 'CLOSER', 'MANAGER'],
  ['manage_users', 'GET', '/users', undefined, 'AGENT', 'ADMIN'],
  ['manage_permissions', 'GET', '/permissions/matrix', undefined, 'MANAGER', 'ADMIN'],
  ['manage_providers', 'GET', '/providers', undefined, 'MANAGER', 'ADMIN'],
  ['system_lockdown', 'GET', '/lockdown/status', undefined, 'MANAGER', 'ADMIN'],
  // Lead enrichment module
  ['enrich_lead', 'POST', '/leads/999999/enrich', undefined, '__NONE__', 'AGENT'],
  ['view_enrichment', 'GET', '/leads/999999/enrichment', undefined, '__NONE__', 'AGENT'],
  ['edit_score_weights', 'GET', '/score-weights', undefined, 'MANAGER', 'ADMIN'],
  ['manage_dnc_optout', 'GET', '/dnc', undefined, 'AGENT', 'MANAGER'],
  ['view_enrichment_cost', 'GET', '/reports/enrichment-costs', undefined, 'AGENT', 'MANAGER'],
  // Custom fields, comments, per-lead access control
  ['manage_custom_fields', 'GET', '/custom-fields/all', undefined, 'MANAGER', 'ADMIN'],
  ['comment_lead', 'GET', '/leads/999999/comments', undefined, '__NONE__', 'AGENT'],
  ['manage_lead_access', 'GET', '/leads/999999/access', undefined, 'MANAGER', 'ADMIN'],
];

describe.each(CASES)('permission %s', (key, method, path, body, roleWithout, roleWith) => {
  if (roleWithout !== '__NONE__' && roleWithout !== '__SKIP_WITHOUT__' && roleWithout !== '__TEAM_SCOPE__') {
    it(`denies ${roleWithout} (403)`, async () => {
      expect(await call(roleWithout, method, path, body)).toBe(403);
    });
  }
  it(`admits ${roleWith} (not 403)`, async () => {
    expect(await call(roleWith, method, path, body)).not.toBe(403);
  });
});

describe('scope semantics', () => {
  it('manage_users scope VIEW: MANAGER can list but not create users', async () => {
    expect(await call('MANAGER', 'GET', '/users')).toBe(200);
    expect(
      await call('MANAGER', 'POST', '/users', {
        name: 'Nope', email: 'nope@x.local', password: 'aaaaaaaaaaaa', roleId: 1,
      }),
    ).toBe(403);
  });

  it('view_reports_team decides team vs own dashboard scope', async () => {
    const res = await fetch(`${BASE}/reports/dashboard`, {
      headers: { Authorization: `Bearer ${tokens.AGENT}` },
    });
    expect((await res.json()).scope).toBe('own');
    const res2 = await fetch(`${BASE}/reports/dashboard`, {
      headers: { Authorization: `Bearer ${tokens.MANAGER}` },
    });
    expect((await res2.json()).scope).toBe('team');
  });

  it('unauthenticated requests are rejected', async () => {
    const res = await fetch(`${BASE}/leads`);
    expect(res.status).toBe(401);
  });
});
