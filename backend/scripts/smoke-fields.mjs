// Custom fields, comments, and per-lead access revocation checks.
const BASE = 'http://localhost:3000/api';
const PASS = process.env.SEED_USER_PASSWORD || 'LeadTrace!Dev1';

async function api(token, method, path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json; try { json = JSON.parse(text); } catch { json = text; }
  return { status: res.status, json };
}
async function login(email) {
  const r = await api(null, 'POST', '/auth/login', { email, password: PASS });
  return { token: r.json.accessToken, user: r.json.user };
}
function assert(cond, label, extra) {
  if (!cond) { console.error(`✗ FAIL: ${label}`, extra ?? ''); process.exitCode = 1; }
  else console.log(`✓ ${label}`);
}
const suffix = String(Date.now() % 100000).padStart(5, '0');

const admin = await login('admin@leadtrace.local');
const manager = await login('manager@leadtrace.local');
const agent = await login('agent@leadtrace.local');
const closer = await login('closer@leadtrace.local');

// ── Custom fields ──
let r = await api(agent.token, 'POST', '/custom-fields', { label: 'Nope' });
assert(r.status === 403, 'agent denied creating field definitions');

r = await api(admin.token, 'POST', '/custom-fields', { label: `Budget ${suffix}`, fieldType: 'NUMBER' });
assert(r.status === 201, 'admin creates NUMBER field', r.json);
const budgetField = r.json;

r = await api(admin.token, 'POST', '/custom-fields', {
  label: `Interest ${suffix}`, fieldType: 'DROPDOWN', options: ['Hot', 'Warm', 'Cold'],
});
assert(r.status === 201, 'admin creates DROPDOWN field with options');
const interestField = r.json;

r = await api(agent.token, 'GET', '/custom-fields');
assert(r.status === 200 && r.json.some((f) => f.id === budgetField.id), 'agent sees active field definitions');

// Lead owned by agent
r = await api(agent.token, 'POST', '/leads', {
  firstName: 'Fields', lastName: 'Test', phones: [{ number: `+1214555${suffix.slice(0, 3)}1` }], force: true,
});
const leadId = r.json.id;

// Fill + edit values (stays editable after customer confirms)
r = await api(agent.token, 'PUT', `/leads/${leadId}/custom-values`, { fieldId: budgetField.id, value: '5000' });
assert(r.status === 200, 'agent fills field on own lead');
r = await api(agent.token, 'PUT', `/leads/${leadId}/custom-values`, { fieldId: budgetField.id, value: '7500' });
assert(r.status === 200, 'value stays editable (customer confirmed new info)');
r = await api(agent.token, 'PUT', `/leads/${leadId}/custom-values`, { fieldId: budgetField.id, value: 'abc' });
assert(r.status === 400, 'NUMBER field rejects non-numeric');
r = await api(agent.token, 'PUT', `/leads/${leadId}/custom-values`, { fieldId: interestField.id, value: 'Volcanic' });
assert(r.status === 400, 'DROPDOWN rejects unknown option');
r = await api(agent.token, 'PUT', `/leads/${leadId}/custom-values`, { fieldId: interestField.id, value: 'Hot' });
assert(r.status === 200, 'DROPDOWN accepts valid option');

r = await api(agent.token, 'GET', `/leads/${leadId}`);
assert(r.json.customValues?.length === 2, 'lead detail returns custom values');
assert(r.json.activities.some((a) => a.detail.includes('updated: "5000"')), 'field changes land on the timeline');

// Closer (not on this lead) cannot fill values — ASSIGNED scope
r = await api(closer.token, 'PUT', `/leads/${leadId}/custom-values`, { fieldId: budgetField.id, value: '1' });
assert(r.status === 403, 'closer denied editing fields on unrelated lead');

// ── Comments ──
r = await api(agent.token, 'POST', `/leads/${leadId}/comments`, { body: 'Customer confirmed budget on call.' });
assert(r.status === 201, 'lead owner (worked it) can comment');
r = await api(manager.token, 'POST', `/leads/${leadId}/comments`, { body: 'Good — push to SS when ready.' });
assert(r.status === 201, 'manager can comment');
r = await api(closer.token, 'POST', `/leads/${leadId}/comments`, { body: 'I never touched this lead' });
assert(r.status === 403, 'uninvolved user cannot comment');
r = await api(agent.token, 'GET', `/leads/${leadId}/comments`);
assert(r.status === 200 && r.json.length === 2, 'comments listed (2)');

// ── Access revocation ──
r = await api(manager.token, 'POST', `/leads/${leadId}/access`, { userId: agent.user.id, reason: 'nope' });
assert(r.status === 403, 'manager denied access management (admin-only by default)');

r = await api(admin.token, 'POST', `/leads/${leadId}/access`, { userId: admin.user.id, reason: 'self' });
assert(r.status === 400, 'admins cannot be blocked');

r = await api(admin.token, 'POST', `/leads/${leadId}/access`, { userId: agent.user.id, reason: 'dispute — reassigning ownership' });
assert(r.status === 201, 'admin revokes agent access to their own lead');

r = await api(agent.token, 'GET', `/leads/${leadId}`);
assert(r.status === 403, 'blocked agent cannot open the lead');
r = await api(agent.token, 'GET', '/leads?scope=own&pageSize=100');
assert(r.status === 200 && !r.json.items.some((l) => l.id === leadId), 'blocked lead vanishes from agent lists');
r = await api(agent.token, 'PUT', `/leads/${leadId}/custom-values`, { fieldId: budgetField.id, value: '1' });
assert(r.status === 403, 'blocked agent cannot edit fields');
r = await api(agent.token, 'POST', `/leads/${leadId}/comments`, { body: 'still here?' });
assert(r.status === 403, 'blocked agent cannot comment');
r = await api(admin.token, 'GET', `/leads/${leadId}`);
assert(r.status === 200, 'admin still sees the lead (immune)');

r = await api(admin.token, 'DELETE', `/leads/${leadId}/access/${agent.user.id}`);
assert(r.status === 200, 'admin restores access');
r = await api(agent.token, 'GET', `/leads/${leadId}`);
assert(r.status === 200, 'agent access restored');

// ── Cleanup: deactivate test fields so they don't clutter the UI ──
await api(admin.token, 'PATCH', `/custom-fields/${budgetField.id}`, { isActive: false });
await api(admin.token, 'PATCH', `/custom-fields/${interestField.id}`, { isActive: false });
r = await api(agent.token, 'GET', '/custom-fields');
assert(!r.json.some((f) => f.id === budgetField.id), 'deactivated field hidden from users (data kept)');

console.log(process.exitCode ? '\nFIELDS/COMMENTS/ACCESS TESTS FAILED' : '\nFIELDS/COMMENTS/ACCESS TESTS PASSED');
