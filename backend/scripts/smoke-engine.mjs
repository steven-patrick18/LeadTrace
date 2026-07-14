const BASE = 'http://localhost:3000/api';
const PASS = 'LeadTrace!Dev1';
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

const admin = await login('admin@leadtrace.local');
const agent = await login('agent@leadtrace.local');

// Catalog shows the engine as adapter-ready
let r = await api(admin.token, 'GET', '/providers');
const engine = r.json.find((p) => p.code === 'LEADTRACE_ENGINE');
assert(engine && engine.implemented === true, 'LeadTrace Engine present + adapter ready');
assert(engine.howToGet?.includes('self-hosted') || engine.description?.includes('self-hosted'), 'engine documented as self-hosted');

// Activate the engine (free tier — no credentials needed, attestation seeded)
r = await api(admin.token, 'PATCH', `/providers/${engine.id}`, { isActive: true });
assert(r.status === 200 && r.json.isActive === true, 'engine activates without credentials (free tier)');

// Engine is active. Isolate it (deactivate all others) so this test asserts
// engine-only behavior — multiple providers may now be active simultaneously.
r = await api(admin.token, 'GET', '/providers');
for (const p of r.json) {
  if (p.code !== 'LEADTRACE_ENGINE' && p.isActive) await api(admin.token, 'PATCH', `/providers/${p.id}`, { isActive: false });
}
r = await api(admin.token, 'GET', '/providers');
const active = r.json.filter((p) => p.isActive);
assert(active.some((p) => p.code === 'LEADTRACE_ENGINE'), 'engine is active');

// Search by a real-format phone → derived record from offline phone/geo facts
r = await api(agent.token, 'POST', '/search', { phone: '(305) 234-5678', zip: '33101' });
assert(r.status === 201 && r.json.providers?.includes('LEADTRACE_ENGINE'), 'search served by engine');
assert(r.json.matches.length >= 1, `engine returned ${r.json.matches?.length} match(es)`);
const m = r.json.matches[0];
assert(m.phones[0].lineType === 'mobile', `phone line type derived offline (${m.phones[0].lineType})`);
assert(m.state === 'FL', `geo derived from zip (state=${m.state})`);

// (Note: 555-01XX is a VALID phone format per libphonenumber, so the engine
// legitimately returns a phone-intel skeleton for it. Truly-invalid input is
// covered by the '000' check below.)

// Search by an existing lead's phone → first-party high-confidence match
const mine = (await api(agent.token, 'GET', '/leads?scope=own&pageSize=1')).json.items[0];
r = await api(agent.token, 'POST', '/search', { phone: mine.primaryPhone.replace('+1', '') });
const fp = r.json.matches.find((x) => x.confidence >= 80);
assert(!!fp, 'existing lead surfaces as high-confidence first-party match');

// Enrich a FRESH lead via the engine (cached leads correctly keep their
// earlier cached blobs — cache-first — so we need an uncached phone here)
const suffix = String(Date.now() % 10000).padStart(4, '0');
r = await api(agent.token, 'POST', '/leads', {
  firstName: 'Engine', lastName: 'Fresh', phones: [{ number: `+1305234${suffix}` }], zip: '33101', force: true,
});
const freshId = r.json.id;
r = await api(agent.token, 'POST', `/leads/${freshId}/enrich`);
assert(r.status === 201 && r.json.providerData?.sourceProvider === 'LEADTRACE_ENGINE', 'enrichment served by engine', r.json.providerData?.sourceProvider);
assert(Array.isArray(r.json.providerData.socialUrls) && r.json.providerData.socialUrls.length === 0, 'engine returns NO social URLs (no scraping)');
assert(r.json.providerData.phones[0].lineType !== undefined, 'engine enrichment has phone intelligence');
assert(r.json.intelligence.leadScore >= 0, `lead score computed (${r.json.intelligence.leadScore})`);
assert(r.json.enrichmentCost === 0, 'engine enrichment costs $0');

// Invalid phone → no derived record
r = await api(agent.token, 'POST', '/search', { phone: '000' });
assert(r.status === 400 || (r.json.matches && r.json.matches.length === 0), 'invalid phone yields no fabricated data');

// Restore MOCK as active for the rest of the demo
const mock = (await api(admin.token, 'GET', '/providers')).json.find((p) => p.code === 'MOCK');
await api(admin.token, 'PATCH', `/providers/${mock.id}`, { isActive: true });
console.log('  (restored MOCK as active provider)');

console.log(process.exitCode ? '\nENGINE TESTS FAILED' : '\nENGINE TESTS PASSED');
