// Providers page backend checks.
const BASE = 'http://localhost:3000/api';
async function api(token, method, path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json; try { json = JSON.parse(text); } catch { json = text; }
  return { status: res.status, json };
}
function assert(cond, label, extra) {
  if (!cond) { console.error(`✗ FAIL: ${label}`, extra ?? ''); process.exitCode = 1; }
  else console.log(`✓ ${label}`);
}

let r = await api(null, 'POST', '/auth/login', { email: 'admin@leadtrace.local', password: 'LeadTrace!Dev1' });
const admin = r.json.accessToken;
r = await api(null, 'POST', '/auth/login', { email: 'manager@leadtrace.local', password: 'LeadTrace!Dev1' });
const manager = r.json.accessToken;

// Catalog listing
r = await api(admin, 'GET', '/providers');
assert(r.status === 200 && r.json.length >= 6, `catalog lists ${r.json.length} providers`);
const byCode = Object.fromEntries(r.json.map((p) => [p.code, p]));
assert(byCode.MOCK?.isActive === true && byCode.MOCK?.implemented === true, 'MOCK active + implemented');
assert(byCode.TRESTLE && byCode.TRESTLE.implemented === false, 'TRESTLE cataloged, adapter pending');
assert(byCode.ENDATO?.howToGet?.includes('AP Name'), 'ENDATO ships how-to-get steps');
assert(!('apiKey' in byCode.MOCK) && !('apiSecret' in byCode.MOCK), 'credentials never returned in GET');

// Manager denied (matrix: manage_providers admin-only)
r = await api(manager, 'GET', '/providers');
assert(r.status === 403, 'manager denied providers page');

// Cannot activate without credentials
r = await api(admin, 'PATCH', `/providers/${byCode.TRESTLE.id}`, { isActive: true });
assert(r.status === 400 && /credentials/i.test(r.json.message), 'activation without credentials rejected');

// Save credentials (write-only) → GET shows last4 only
r = await api(admin, 'PATCH', `/providers/${byCode.TRESTLE.id}`, { apiKey: 'test-key-ABCD1234' });
assert(r.status === 200 && r.json.hasApiKey === true && r.json.apiKeyLast4 === '1234', 'credentials saved, only last4 exposed');

// Still cannot activate: attestation missing → then adapter missing
r = await api(admin, 'PATCH', `/providers/${byCode.TRESTLE.id}`, { isActive: true });
assert(r.status === 400 && /adapter|attestation/i.test(r.json.message), `activation still guarded (${r.json.message?.slice(0, 60)}…)`);
r = await api(admin, 'PATCH', `/providers/${byCode.TRESTLE.id}`, {
  isActive: true,
  permittedUseAttestation: 'Sales lead generation only; no FCRA/DPPA/GLBA-restricted uses. Signed for testing.',
});
assert(r.status === 400 && /adapter/i.test(r.json.message), 'adapter-pending provider cannot go active');

// MOCK stays active throughout
r = await api(admin, 'GET', '/providers');
assert(r.json.find((p) => p.code === 'MOCK').isActive === true, 'MOCK still the active provider');

// Custom provider creation
r = await api(admin, 'POST', '/providers', {
  code: 'TEST_CUSTOM', displayName: 'Test Custom', description: 'temp',
  howToGet: '1. test', websiteUrl: 'https://example.com',
});
assert(r.status === 201 && r.json.isActive === false && r.json.implemented === false, 'custom provider added, inactive');
r = await api(admin, 'POST', '/providers', { code: 'TEST_CUSTOM', displayName: 'Dup' });
assert(r.status === 409, 'duplicate code rejected');

// Search still works end-to-end on MOCK
r = await api(admin, 'POST', '/search', { lastName: 'Garcia' });
assert(r.status === 201 || r.status === 200, 'search unaffected by refactor', r.json?.message);

console.log(process.exitCode ? '\nPROVIDER TESTS FAILED' : '\nPROVIDER TESTS PASSED');
