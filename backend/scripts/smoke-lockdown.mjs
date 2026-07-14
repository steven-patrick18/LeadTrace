// Lockdown behavior test (spec §7) against the dev server.
const BASE = 'http://localhost:3000';
const WAKE = `${BASE}/__wake-x7f9q2`;

async function api(token, method, path, body) {
  const res = await fetch(`${BASE}/api${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
    redirect: 'manual',
  });
  const text = await res.text();
  let json; try { json = JSON.parse(text); } catch { json = text; }
  return { status: res.status, json, text, headers: res.headers };
}
function assert(cond, label, extra) {
  if (!cond) { console.error(`✗ FAIL: ${label}`, extra ?? ''); process.exitCode = 1; }
  else console.log(`✓ ${label}`);
}

let r = await api(null, 'POST', '/auth/login', { email: 'admin@leadtrace.local', password: 'LeadTrace!Dev1' });
const admin = r.json.accessToken;

// Lockdown refused without a recovery key
r = await api(admin, 'GET', '/lockdown/status');
if (!r.json.hasActiveRecoveryKey) {
  r = await api(admin, 'POST', '/lockdown/trigger', { confirmed: true });
  assert(r.status === 400, 'lockdown refused until a recovery key exists', r.status);
}

// Generate key — shown once
r = await api(admin, 'POST', '/lockdown/recovery-key');
const key = r.json.recoveryKey;
assert(/^WK-[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}$/.test(key), `recovery key format ok (${key})`);

// Trigger lockdown (confirmed)
r = await api(admin, 'POST', '/lockdown/trigger', { confirmed: true });
assert(r.json.status === 'LOCKED', 'lockdown triggered', r.json);
await new Promise((res) => setTimeout(res, 5200)); // wait out the 5s state cache

// EVERYTHING blacked out — even the admin's own session (empty 503)
r = await api(admin, 'GET', '/routing/queue');
assert(r.status === 503 && r.text === '', 'admin session blacked out: empty 503', { s: r.status, t: r.text });
r = await api(null, 'POST', '/auth/login', { email: 'admin@leadtrace.local', password: 'LeadTrace!Dev1' });
assert(r.status === 503 && r.text === '', 'login blacked out too');

// Wake page reachable, unbranded
let page = await fetch(WAKE);
let html = await page.text();
assert(page.status === 200 && html.includes('name="key"') && !html.toLowerCase().includes('leadtrace'), 'bare wake page served, unbranded');

// Wrong key → generic error, no hints
let form = await fetch(WAKE, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ key: 'WK-AAAA-BBBB-CCCC-DDDD' }),
  redirect: 'manual',
});
html = await form.text();
assert(html.includes('invalid') && !html.includes('rate') && !html.includes('key is'), 'wrong key gets generic error');

// Correct key → redirect to login, system ACTIVE
form = await fetch(WAKE, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ key }),
  redirect: 'manual',
});
assert(form.status === 302, 'correct key wakes system (302 redirect)', form.status);
await new Promise((res) => setTimeout(res, 5200));
r = await api(null, 'POST', '/auth/login', { email: 'admin@leadtrace.local', password: 'LeadTrace!Dev1' });
assert(r.status === 201 || r.status === 200, 'system active again — login works');

// Regenerated key kills the old one
const admin2 = r.json.accessToken;
r = await api(admin2, 'POST', '/lockdown/recovery-key');
const key2 = r.json.recoveryKey;
assert(key2 !== key, 'regenerate returns a new key');

console.log(process.exitCode ? '\nLOCKDOWN TEST FAILED' : '\nLOCKDOWN TESTS PASSED');
