// Lead Enrichment module checks (spec sections A/C/D/E + definition of done).
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

const agent = await login('agent@leadtrace.local');
const manager = await login('manager@leadtrace.local');
const admin = await login('admin@leadtrace.local');

// Clean lead with a "clear" phone (mock DNC: must not end in 7/4 or "13")
let r = await api(agent.token, 'POST', '/leads', {
  firstName: 'Enrich', lastName: 'Testcase',
  phones: [{ number: `+1305555${suffix.slice(0, 3)}2` }],
  address: '100 Oak St', city: 'Miami', state: 'FL', zip: '33101', force: true,
});
assert(r.status === 201, 'clean lead created', r.json);
const cleanLead = r.json.id;

// 1. Enrich → COMPLETE with all four sections
r = await api(agent.token, 'POST', `/leads/${cleanLead}/enrich`);
assert(r.status === 201, 'enrich runs', r.json);
assert(r.json.status === 'COMPLETE', `status COMPLETE (got ${r.json.status})`);
assert(r.json.providerData?.phones?.length > 0, 'section A: provider data with phones');
assert(r.json.geoData?.timezone === 'America/New_York', 'section C: FL zip → America/New_York tz');
assert(typeof r.json.geoData?.localTimeNow === 'string', 'localTimeNow derived on read');
assert(r.json.complianceData?.callable === true, 'section D: clean phone is callable');
assert(r.json.intelligence?.leadScore > 0 && r.json.intelligence?.scoreBreakdown?.length > 0, `section E: score ${r.json.intelligence?.leadScore} with breakdown`);
assert(r.json.intelligence?.conversionProbabilityMethod === 'heuristic', 'conversion probability uses transparent heuristic');
const firstScore = r.json.intelligence.leadScore;

// 2. Cache-first: immediate re-enrich costs $0
r = await api(agent.token, 'POST', `/leads/${cleanLead}/enrich`);
assert(r.status === 201 && r.json.enrichmentCost === 0, 'second enrich within TTL costs $0 (cache-first)', r.json.enrichmentCost);

// 3. GET endpoint + census stays area-level
r = await api(agent.token, 'GET', `/leads/${cleanLead}/enrichment`);
assert(r.status === 200 && r.json.intelligence.leadScore === firstScore, 'stored enrichment retrievable, score reproducible');
if (r.json.geoData?.censusAreaStats) {
  assert(/area/i.test(r.json.geoData.censusAreaStats.note), 'census stats labeled area-level');
}

// 4. CALL logging allowed on callable lead
r = await api(agent.token, 'POST', `/leads/${cleanLead}/activities`, { type: 'CALL', detail: 'Connected, interested' });
assert(r.status === 201, 'CALL allowed on callable lead');

// 5. DNC lead (mock scrub: phone ending in 7 → national DNC)
r = await api(agent.token, 'POST', '/leads', {
  firstName: 'Dnc', lastName: 'Blocked',
  phones: [{ number: `+1305555${suffix.slice(0, 3)}7` }],
  city: 'Miami', state: 'FL', zip: '33101', force: true,
});
const dncLead = r.json.id;
r = await api(agent.token, 'POST', `/leads/${dncLead}/enrich`);
assert(r.json.complianceData?.callable === false, 'DNC phone → callable=false');
assert(r.json.complianceData?.nationalDncStatus === 'on_list', 'national DNC detected');
assert(r.json.intelligence.leadScore <= 25, `not-callable score hard-capped (${r.json.intelligence.leadScore} ≤ 25)`);
assert(r.json.intelligence.conversionProbability === 0, 'conversion probability zeroed when not callable');

// 6. The gate: CALL blocked + logged; NOTE still fine
r = await api(agent.token, 'POST', `/leads/${dncLead}/activities`, { type: 'CALL', detail: 'should not happen' });
assert(r.status === 409 && r.json.reasons?.length > 0, 'CALL on DNC lead blocked with reasons', r.json);
r = await api(agent.token, 'POST', `/leads/${dncLead}/activities`, { type: 'NOTE', detail: 'DNC — do not contact' });
assert(r.status === 201, 'NOTE still allowed on DNC lead');

// 7. Internal opt-out list is authoritative and live (no re-enrich needed)
const cleanPhone = `+1305555${suffix.slice(0, 3)}2`;
r = await api(agent.token, 'GET', '/dnc');
assert(r.status === 403, 'agent denied DNC management');
r = await api(manager.token, 'POST', '/dnc', { phone: cleanPhone, reason: 'smoke test opt-out' });
assert(r.status === 201, 'manager adds phone to internal opt-out');
r = await api(agent.token, 'POST', `/leads/${cleanLead}/activities`, { type: 'CALL', detail: 'should be blocked now' });
assert(r.status === 409, 'internal opt-out blocks calling immediately (no re-enrich)', r.status);
const dncRows = (await api(manager.token, 'GET', '/dnc')).json;
const row = dncRows.find((x) => x.phone === cleanPhone);
r = await api(manager.token, 'DELETE', `/dnc/${row.id}`);
assert(r.status === 200, 'opt-out entry removable (audited)');

// 8. Score weights: admin-editable, agents denied
r = await api(agent.token, 'GET', '/score-weights');
assert(r.status === 403, 'agent denied score weights');
r = await api(admin.token, 'PATCH', '/score-weights', { key: 'property_owner', weight: 25 });
assert(r.status === 200 && r.json.weight === 25, 'admin edits weight');
r = await api(admin.token, 'PATCH', '/score-weights', { key: 'property_owner', weight: 15 });
assert(r.status === 200, 'weight restored');

// 9. Cost report permissions
r = await api(agent.token, 'GET', '/reports/enrichment-costs');
assert(r.status === 403, 'agent denied enrichment costs');
r = await api(manager.token, 'GET', '/reports/enrichment-costs');
assert(r.status === 200 && r.json.enrichmentRuns >= 1, `manager sees enrichment costs (${r.json.enrichmentRuns} runs)`);

// 10. Social URLs: present as plain strings, never fetched (static test covers code)
r = await api(agent.token, 'GET', `/leads/${cleanLead}/enrichment`);
const urls = r.json.providerData?.socialUrls ?? [];
assert(urls.every((u) => typeof u === 'string' && u.startsWith('http')), `socialUrls are plain URL strings (${urls.length})`);

console.log(process.exitCode ? '\nENRICHMENT TESTS FAILED' : '\nENRICHMENT TESTS PASSED');
