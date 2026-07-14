// End-to-end smoke test of the LeadTrace call chain against the dev server.
const BASE = 'http://localhost:3000/api';
const PASS = 'LeadTrace!Dev1';

async function api(token, method, path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = text; }
  return { status: res.status, json };
}

async function login(email) {
  const r = await api(null, 'POST', '/auth/login', { email, password: PASS });
  if (r.status !== 201 && r.status !== 200) throw new Error(`login ${email} failed: ${JSON.stringify(r.json)}`);
  return { token: r.json.accessToken, user: r.json.user };
}

function assert(cond, label, extra) {
  if (!cond) { console.error(`✗ FAIL: ${label}`, extra ?? ''); process.exitCode = 1; }
  else console.log(`✓ ${label}`);
}

const agent = await login('agent@leadtrace.local');
const admin = await login('admin@leadtrace.local');
const ss = await login('sragent@leadtrace.local');
const closer = await login('closer@leadtrace.local');

// 1. Agent searches by last name
let r = await api(agent.token, 'POST', '/search', { lastName: 'Smith' });
assert(r.status === 201 || r.status === 200, 'agent can search providers', r.json);
const matches = r.json.matches ?? [];
assert(matches.length > 0, `search returned matches (${matches.length})`);
const m = matches[0];

// 2. Cache hit on identical (differently-cased) query
r = await api(agent.token, 'POST', '/search', { lastName: 'SMITH' });
assert(r.json.cacheHit === true, 'equivalent search hits cache (normalized search_key)');

// 3. Closer must NOT be able to search (matrix: search_providers ❌ for CLOSER)
r = await api(closer.token, 'POST', '/search', { lastName: 'Smith' });
assert(r.status === 403, 'closer denied search_providers by matrix', r.status);

// 4. Agent one-click converts to lead (force:true so the script is re-runnable;
//    the duplicate guard itself is asserted in step 5)
r = await api(agent.token, 'POST', '/leads', {
  firstName: m.firstName, lastName: m.lastName, phones: m.phones,
  address: m.address, city: m.city, state: m.state, zip: m.zip,
  sourceProvider: m.sourceProvider, rawProviderData: m, force: true,
});
assert(r.status === 201, 'agent creates lead from match', r.json);
const leadId = r.json.id;
assert(r.json.status === 'NEW' && r.json.currentTier === 'AGENT', 'lead starts NEW @ AGENT tier');

// 5. Duplicate phone warning
r = await api(agent.token, 'POST', '/leads', {
  firstName: 'Dup', lastName: 'Test', phones: m.phones,
});
assert(r.status === 409, 'duplicate phone blocked with 409 warning', r.status);

// 6. Agent requests transfer (T1)
r = await api(agent.token, 'POST', `/routing/leads/${leadId}/request-transfer`, { note: 'warm prospect' });
assert(r.status === 201, 'agent requests transfer', r.json);

// 7. Agent cannot route (matrix: route_leads ❌)
r = await api(agent.token, 'GET', '/routing/queue');
assert(r.status === 403, 'agent denied routing queue');

// 8. Admin sees queue, routes to SS
r = await api(admin.token, 'GET', '/routing/queue');
const myT1 = r.json.T1_TO_SS?.find((x) => x.lead.id === leadId);
assert(r.status === 200 && !!myT1, 'admin sees T1 queue row', r.json);
const queueId = myT1.id;
r = await api(admin.token, 'POST', `/routing/queue/${queueId}/route`, { toUserId: ss.user.id });
assert(r.status === 201, 'admin routes to SS', r.json);

// 9. Routing to wrong tier must fail — try routing a T2 row to an agent later; here check lead state
r = await api(ss.token, 'GET', `/leads/${leadId}`);
assert(r.status === 200 && r.json.currentTier === 'SR_AGENT' && r.json.status === 'IN_PROGRESS', 'lead now @ SR_AGENT, IN_PROGRESS');

// 10. SS logs a call, requests transfer (T2)
r = await api(ss.token, 'POST', `/leads/${leadId}/activities`, { type: 'CALL', detail: 'Qualified, budget confirmed' });
assert(r.status === 201, 'SS logs call activity');
r = await api(ss.token, 'POST', `/routing/leads/${leadId}/request-transfer`, {});
assert(r.status === 201, 'SS requests transfer to closer');

// 11. Admin routes T2 — but first prove tier validation: try routing to the agent
r = await api(admin.token, 'GET', '/routing/queue');
const t2 = r.json.T2_TO_CLOSER.find((x) => x.lead.id === leadId);
r = await api(admin.token, 'POST', `/routing/queue/${t2.id}/route`, { toUserId: agent.user.id });
assert(r.status === 400, 'T2 route to non-closer rejected', r.status);
r = await api(admin.token, 'POST', `/routing/queue/${t2.id}/route`, { toUserId: closer.user.id });
assert(r.status === 201, 'admin routes to closer');

// 12. SS (not assigned anymore) cannot edit lead — ASSIGNED scope
r = await api(ss.token, 'PATCH', `/leads/${leadId}`, { city: 'Nowhere' });
assert(r.status === 403, 'SS edit denied after lead moved on (ASSIGNED scope)');

// 13. Closer closes WON
r = await api(closer.token, 'POST', `/routing/leads/${leadId}/close`, { outcome: 'CLOSED_WON', note: 'signed!' });
assert(r.status === 201, 'closer closes deal WON', r.json);

// 14. Closed lead can't request transfer / send back
r = await api(closer.token, 'POST', `/routing/leads/${leadId}/send-back`, { reason: 'oops' });
assert(r.status === 400, 'closed lead cannot be sent back');

// 15. Admin reopens (logged) → back through queue
r = await api(admin.token, 'POST', `/routing/leads/${leadId}/reopen`, { reason: 'customer called back' });
assert(r.status === 201, 'admin reopen puts lead back in queue');
r = await api(admin.token, 'GET', '/routing/queue');
const t3 = r.json.T3_SEND_BACK.find((x) => x.lead.id === leadId);
assert(!!t3, 'reopened lead sits in T3 queue');
r = await api(admin.token, 'POST', `/routing/queue/${t3.id}/route`, { toUserId: ss.user.id });
assert(r.status === 201, 'admin re-routes reopened lead to SS');

// 16. Closer sends back via queue (need lead at closer again)
r = await api(ss.token, 'POST', `/routing/leads/${leadId}/request-transfer`, {});
r = await api(admin.token, 'GET', '/routing/queue');
const t2b = r.json.T2_TO_CLOSER.find((x) => x.lead.id === leadId);
r = await api(admin.token, 'POST', `/routing/queue/${t2b.id}/route`, { toUserId: closer.user.id });
r = await api(closer.token, 'POST', `/routing/leads/${leadId}/send-back`, { reason: 'not ready, needs warming' });
assert(r.status === 201, 'closer send-back goes through admin queue');

// 17. Reports: agent sees own-only, manager sees team
const manager = await login('manager@leadtrace.local');
r = await api(manager.token, 'GET', '/reports/dashboard');
assert(r.status === 200 && r.json.scope === 'team', 'manager dashboard is team-wide');
r = await api(agent.token, 'GET', '/reports/dashboard');
assert(r.status === 200 && r.json.scope === 'own', 'agent dashboard is own-only');
assert(r.json.funnel.created >= 1 && r.json.funnel.reachedSS >= 1, 'funnel reads from routing_history');
r = await api(agent.token, 'GET', '/reports/api-costs');
assert(r.status === 403, 'agent denied api costs');
r = await api(manager.token, 'GET', '/reports/api-costs');
assert(r.status === 200, 'manager sees api costs');

// 18. Notifications: SS got routed-lead notifications
r = await api(ss.token, 'GET', '/notifications/unread-count');
assert(r.status === 200 && r.json.count > 0, `SS has unread notifications (${r.json.count})`);

// 19. Permission edit flow: grant route_leads to MANAGER, verify zero-code-change routing
r = await api(admin.token, 'GET', '/users/roles');
const managerRole = r.json.find((x) => x.roleCode === 'MANAGER');
r = await api(manager.token, 'GET', '/routing/queue');
assert(r.status === 403, 'manager denied routing before grant');
r = await api(admin.token, 'PATCH', `/permissions/roles/${managerRole.id}`, { permissionKey: 'route_leads', allowed: true, scope: 'ALL' });
assert(r.status === 200, 'admin grants route_leads to MANAGER');
r = await api(manager.token, 'GET', '/routing/queue');
assert(r.status === 200, 'manager can route after grant — zero code change');
r = await api(admin.token, 'PATCH', `/permissions/roles/${managerRole.id}`, { permissionKey: 'route_leads', allowed: false, scope: 'ALL' });
assert(r.status === 200, 'revoke works too');

// 20. Bulk routing
const bulkLeads = [];
for (let i = 0; i < 3; i++) {
  r = await api(agent.token, 'POST', '/leads', {
    firstName: `Bulk${i}`, lastName: 'Tester', phones: [{ number: `+1303555030${i}` }], force: true,
  });
  bulkLeads.push(r.json.id);
  await api(agent.token, 'POST', `/routing/leads/${r.json.id}/request-transfer`, {});
}
r = await api(admin.token, 'GET', '/routing/queue');
const bulkRows = r.json.T1_TO_SS.filter((x) => bulkLeads.includes(x.lead.id)).map((x) => x.id);
r = await api(admin.token, 'POST', '/routing/queue/bulk-route', { queueIds: bulkRows, toUserId: ss.user.id });
assert(r.status === 201 && r.json.length === 3, 'bulk routing: 3 leads → one SS in one action');

console.log(process.exitCode ? '\nSMOKE TEST FAILED' : '\nALL SMOKE TESTS PASSED');
