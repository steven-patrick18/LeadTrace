const BASE = 'http://localhost:3000/api';
const PASS = 'LeadTrace!Dev1';
async function api(token, method, path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const t = await res.text(); let j; try { j = JSON.parse(t); } catch { j = t; }
  return { status: res.status, json: j };
}
async function login(e) { const r = await api(null, 'POST', '/auth/login', { email: e, password: PASS }); return r.json.accessToken; }
function assert(c, l, x) { if (!c) { console.error(`✗ ${l}`, x ?? ''); process.exitCode = 1; } else console.log(`✓ ${l}`); }
const sfx = String(Date.now() % 100000).padStart(5, '0');

const admin = await login('admin@leadtrace.local');
const agent = await login('agent@leadtrace.local');

// Activate BOTH Mock and LeadTrace Engine (multi-provider)
let r = await api(admin.token ?? admin, 'GET', '/providers');
const provs = (await api(admin, 'GET', '/providers')).json;
const mock = provs.find(p => p.code === 'MOCK');
const engine = provs.find(p => p.code === 'LEADTRACE_ENGINE');
await api(admin, 'PATCH', `/providers/${mock.id}`, { isActive: true });
r = await api(admin, 'PATCH', `/providers/${engine.id}`, { isActive: true });
assert(r.status === 200, 'activated LeadTrace Engine alongside Mock (multiple active)');
const activeNow = (await api(admin, 'GET', '/providers')).json.filter(p => p.isActive).map(p => p.code);
assert(activeNow.includes('MOCK') && activeNow.includes('LEADTRACE_ENGINE'), `multiple providers active: ${activeNow.join(', ')}`);

// Create a fresh lead + enrich → should merge from both providers
r = await api(agent, 'POST', '/leads', { firstName: 'Multi', lastName: 'Provider', phones: [{ number: `+1305234${sfx.slice(0,4)}` }], zip: '33101', force: true });
const leadId = r.json.id;
r = await api(agent, 'POST', `/leads/${leadId}/enrich`);
assert(r.status === 201, 'enrich runs with multiple providers', r.json?.status);
const pd = r.json.providerData;
assert(Array.isArray(pd.sources) && pd.sources.length === 2, `merged from 2 providers (sources: ${pd.sources?.join('+')})`);
assert(typeof pd.accuracyScore === 'number', `cross-provider accuracy score present (${pd.accuracyScore}%)`);
assert(pd.sourceProvider.includes('+'), `sourceProvider shows merge (${pd.sourceProvider})`);
const verifiedPhone = pd.phones.find(p => p.verifiedBy >= 2);
console.log(`  phones: ${pd.phones.map(p => p.number + (p.verifiedBy ? ` (×${p.verifiedBy})` : '')).join(', ')}`);

// Search also queries both providers
r = await api(agent, 'POST', '/search', { lastName: 'Garcia', zip: '33101' });
assert(r.status === 201 || r.status === 200, 'search runs across active providers', r.json?.message);
assert(Array.isArray(r.json.providers) && r.json.providers.length >= 1, `search used providers: ${r.json.providers?.join(', ')}`);

// Deactivate engine, back to single provider
await api(admin, 'PATCH', `/providers/${engine.id}`, { isActive: false });
r = await api(agent, 'POST', '/leads', { firstName: 'Single', lastName: 'Provider', phones: [{ number: `+1305234${sfx.slice(1,5)}` }], zip: '33101', force: true });
const lead2 = r.json.id;
r = await api(agent, 'POST', `/leads/${lead2}/enrich`);
assert(r.json.providerData.sources.length === 1, 'single active provider → sources length 1');

console.log(process.exitCode ? '\nMULTI-PROVIDER TESTS FAILED' : '\nMULTI-PROVIDER TESTS PASSED');
