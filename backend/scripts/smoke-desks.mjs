// Batch-ID desk session checks: clock-in, call gating, takeover, force-complete.
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

// Everyone starts clocked out for a clean test
await api(agent.token, 'POST', '/desks/clock-out');
await api(closer.token, 'POST', '/desks/clock-out');

// Bad batch id
let r = await api(agent.token, 'POST', '/desks/clock-in', { batchCode: 'DESK-NOPE' });
assert(r.status === 400, 'unknown batch ID rejected');

// Desk discipline is an OPTIONAL setting (off by default, so quick sessions
// aren't blocked). Turn it on for the strict-gate assertions, restore after.
await api(admin.token, 'PATCH', '/settings', { requireDeskForCalls: true });

// With discipline ON: call without a desk session is refused
r = await api(agent.token, 'POST', '/leads', {
  firstName: 'Desk', lastName: 'Gate', phones: [{ number: `+1602555${suffix.slice(0, 3)}2` }], force: true,
});
const leadId = r.json.id;
r = await api(agent.token, 'POST', `/leads/${leadId}/activities`, { type: 'CALL', detail: 'no seat!' });
assert(r.status === 409 && /clock in|desk/i.test(r.json.message), 'CALL refused without a desk session (discipline on)');
r = await api(agent.token, 'POST', `/leads/${leadId}/activities`, { type: 'NOTE', detail: 'notes are fine anywhere' });
assert(r.status === 201, 'NOTE allowed without a desk session');

// Clock in → call works and is tagged with the session
r = await api(agent.token, 'POST', '/desks/clock-in', { batchCode: 'DESK-01' });
assert(r.status === 201, 'agent clocks in with batch id DESK-01');
r = await api(agent.token, 'GET', '/desks/me');
assert(r.json.clockedIn === true && r.json.desk.code === 'DESK-01', 'desks/me shows the active seat');
r = await api(agent.token, 'POST', `/leads/${leadId}/activities`, { type: 'CALL', detail: 'first dial from my seat' });
assert(r.status === 201 && r.json.deskSessionId, 'CALL logged and attributed to the desk session');

// Takeover: the closer sits at the agent's seat and enters its batch id
r = await api(closer.token, 'POST', '/desks/clock-in', { batchCode: 'DESK-01' });
assert(r.status === 201, 'closer takes over DESK-01');
r = await api(agent.token, 'GET', '/desks/me');
assert(r.json.clockedIn === false, 'agent session force-completed by the takeover');
r = await api(agent.token, 'GET', '/notifications');
assert(r.json.some((n) => n.type === 'DESK_TAKEOVER'), 'agent notified about the takeover');

// Manager: floor is view-only
r = await api(manager.token, 'GET', '/desks/floor');
assert(r.status === 200 && r.json.desks.length >= 6, 'manager sees the desk floor');
r = await api(manager.token, 'POST', '/desks', { code: 'DESK-77', name: 'Nope' });
assert(r.status === 403, 'manager cannot create desks (VIEW scope)');
r = await api(agent.token, 'GET', '/desks/floor');
assert(r.status === 403, 'agent denied the floor view');

// Admin: create desk + force-complete the closer's session
r = await api(admin.token, 'POST', '/desks', { code: `DESK-${suffix.slice(0, 2)}X`, name: 'Overflow seat' });
assert(r.status === 201, 'admin adds a new desk');
r = await api(admin.token, 'GET', '/desks/floor');
const occupied = r.json.desks.find((d) => d.code === 'DESK-01')?.occupant;
assert(occupied?.user?.id === closer.user.id, 'floor shows the closer on DESK-01');
r = await api(admin.token, 'POST', `/desks/sessions/${occupied.sessionId}/force-complete`);
assert(r.status === 201 || r.status === 200, 'admin force-completes the session');
r = await api(closer.token, 'GET', '/desks/me');
assert(r.json.clockedIn === false, 'closer session ended by force-complete');

// Restore the demo floor state + default settings (discipline off)
await api(admin.token, 'PATCH', '/settings', { requireDeskForCalls: false });
await api(agent.token, 'POST', '/desks/clock-in', { batchCode: 'DESK-01' });
await api(closer.token, 'POST', '/desks/clock-in', { batchCode: 'DESK-05' });

console.log(process.exitCode ? '\nDESK TESTS FAILED' : '\nDESK TESTS PASSED');
