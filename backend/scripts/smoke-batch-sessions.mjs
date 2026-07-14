// Quick batch-ID session checks: start on a colleague's screen, work as
// yourself, owner visibility + revoke, auto-expiry semantics, rate limiting.
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

const agent = await login('agent@leadtrace.local'); // the screen with the live call
const closer = await login('closer@leadtrace.local'); // walks over to that screen

// Everyone can see their own batch id
let r = await api(closer.token, 'GET', '/users/my-batch-id');
assert(r.json.batchId === 'LT-CARL', 'closer sees own batch ID (LT-CARL)');

// Wrong batch id → generic 401
r = await api(agent.token, 'POST', '/auth/batch-session', { batchId: 'LT-WRONG' });
assert(r.status === 401, 'invalid batch ID rejected');

// Using your own id is pointless → blocked
r = await api(agent.token, 'POST', '/auth/batch-session', { batchId: 'LT-AMY' });
assert(r.status === 403, 'cannot batch-switch to yourself');

// The real flow: closer types LT-CARL on the agent's screen
r = await api(agent.token, 'POST', '/auth/batch-session', { batchId: 'LT-CARL' });
assert(r.status === 201 && r.json.accessToken && r.json.user.roleCode === 'CLOSER', 'quick session starts as the Closer');
assert(r.json.minutes >= 5 && new Date(r.json.expiresAt) > new Date(), `duration from admin setting (${r.json.minutes}m)`);
const batchToken = r.json.accessToken;
const sessionId = r.json.sessionId;

// The batch token really IS the closer
r = await api(batchToken, 'GET', '/users/my-batch-id');
assert(r.json.batchId === 'LT-CARL', 'batch token acts as the Closer');
r = await api(batchToken, 'GET', '/permissions/me');
assert(r.json.close_deal?.allowed === true && r.json.search_providers?.allowed === false, 'Closer permissions apply (close_deal yes, search no)');

// Owner visibility: the closer sees the session on their own panel
r = await api(closer.token, 'GET', '/auth/batch-sessions/mine');
assert(r.json.length >= 1 && r.json[0].onScreenOf.name === 'Amy Agent', 'closer sees active session on Amy\'s screen');
r = await api(closer.token, 'GET', '/notifications');
assert(r.json.some((n) => n.type === 'BATCH_SESSION'), 'closer notified their batch ID was used');

// Owner revoke kills the token immediately
r = await api(closer.token, 'POST', `/auth/batch-sessions/${sessionId}/revoke`);
assert(r.status === 201 || r.status === 200, 'owner revokes the session');
r = await api(batchToken, 'GET', '/users/my-batch-id');
assert(r.status === 401, 'revoked batch token is dead');

// Start another and end it from the screen (the End button path)
r = await api(agent.token, 'POST', '/auth/batch-session', { batchId: 'LT-CARL' });
const batchToken2 = r.json.accessToken;
r = await api(batchToken2, 'POST', '/auth/batch-session/end');
assert(r.status === 201 || r.status === 200, 'session ended from the screen');
r = await api(closer.token, 'GET', '/auth/batch-sessions/mine');
assert(r.json.length === 0, 'no active sessions left under the closer');
r = await api(batchToken2, 'GET', '/users/my-batch-id');
assert(r.status === 401, 'ended token is dead');

// Rate limiting on guessing
let blocked = false;
for (let i = 0; i < 6; i++) {
  const rr = await api(agent.token, 'POST', '/auth/batch-session', { batchId: `LT-GUESS${i}` });
  if (rr.status === 403) blocked = true;
}
assert(blocked, 'repeated bad attempts rate-limited (5/15min)');

console.log(process.exitCode ? '\nBATCH SESSION TESTS FAILED' : '\nBATCH SESSION TESTS PASSED');
