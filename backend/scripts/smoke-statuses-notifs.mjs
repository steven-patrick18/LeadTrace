// Per-tier work statuses, field rename/delete, watcher notifications,
// click-to-read behavior, provider request limits.
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

// ── Tier status lists ──
let r = await api(agent.token, 'GET', '/tier-statuses');
assert(r.status === 200 && r.json.AGENT?.length >= 3 && r.json.CLOSER?.length >= 3, 'per-tier status lists load');
const agentStatus = r.json.AGENT[1];
const closerStatus = r.json.CLOSER[0];

// Agent lead
r = await api(agent.token, 'POST', '/leads', {
  firstName: 'Status', lastName: 'Case', phones: [{ number: `+1214777${suffix.slice(0, 4)}` }], zip: '75201', force: true,
});
const leadId = r.json.id;

// Wrong tier's status rejected; right tier accepted + timeline
r = await api(agent.token, 'PUT', `/leads/${leadId}/work-status`, { statusId: closerStatus.id });
assert(r.status === 400 && /belongs to the CLOSER list/.test(r.json.message), 'closer-list status rejected on agent-tier lead');
r = await api(agent.token, 'PUT', `/leads/${leadId}/work-status`, { statusId: agentStatus.id });
assert(r.status === 200 && r.json.workStatus?.label === agentStatus.label, `agent sets "${agentStatus.label}"`);
r = await api(agent.token, 'GET', `/leads/${leadId}`);
assert(r.json.activities.some((a) => a.detail.includes(`Work status → "${agentStatus.label}"`)), 'status change on timeline');

// Routing resets work status (new tier, new list)
await api(agent.token, 'POST', `/routing/leads/${leadId}/request-transfer`, {});
const q = (await api(admin.token, 'GET', '/routing/queue')).json;
const row = q.T1_TO_SS.find((x) => x.lead.id === leadId);
const ss = await login('sragent@leadtrace.local');
await api(admin.token, 'POST', `/routing/queue/${row.id}/route`, { toUserId: ss.user.id });
r = await api(admin.token, 'GET', `/leads/${leadId}`);
assert(r.json.workStatus === null, 'work status reset when routed to next tier');

// Admin status CRUD
r = await api(agent.token, 'POST', '/tier-statuses', { tier: 'AGENT', label: 'Nope' });
assert(r.status === 403, 'agent denied status management');
r = await api(admin.token, 'POST', '/tier-statuses', { tier: 'AGENT', label: `Temp ${suffix}` });
assert(r.status === 201, 'admin adds a status');
const temp = r.json;
r = await api(admin.token, 'PATCH', `/tier-statuses/${temp.id}`, { label: `Temp2 ${suffix}` });
assert(r.status === 200 && r.json.label === `Temp2 ${suffix}`, 'admin renames a status');
r = await api(admin.token, 'DELETE', `/tier-statuses/${temp.id}`);
assert(r.status === 200, 'unused status deleted');
// A status IN USE refuses hard delete: pin one to a fresh agent-tier lead
r = await api(agent.token, 'POST', '/leads', {
  firstName: 'Pinned', lastName: 'Status', phones: [{ number: `+1214778${suffix.slice(0, 4)}` }], force: true,
});
const pinnedLead = r.json.id;
await api(agent.token, 'PUT', `/leads/${pinnedLead}/work-status`, { statusId: agentStatus.id });
r = await api(admin.token, 'DELETE', `/tier-statuses/${agentStatus.id}`);
assert(r.status === 400 && /deactivate/i.test(r.json.message), 'used status refuses hard delete');
await api(agent.token, 'PUT', `/leads/${pinnedLead}/work-status`, { statusId: null }); // unpin

// ── Field rename + delete ──
r = await api(admin.token, 'POST', '/custom-fields', { label: `Zombie ${suffix}` });
const zombie = r.json;
r = await api(admin.token, 'PATCH', `/custom-fields/${zombie.id}`, { label: `Renamed ${suffix}` });
assert(r.status === 200 && r.json.label === `Renamed ${suffix}`, 'field renamed');
r = await api(admin.token, 'DELETE', `/custom-fields/${zombie.id}`);
assert(r.status === 200, 'valueless field deleted');
const fields = (await api(admin.token, 'GET', '/custom-fields')).json;
const usedField = fields.find((f) => f.label.startsWith('Product interest'));
if (usedField) {
  r = await api(admin.token, 'DELETE', `/custom-fields/${usedField.id}`);
  assert(r.status === 400, 'field with values refuses hard delete');
}

// ── Watcher notifications + click-to-read ──
const before = (await api(manager.token, 'GET', '/notifications/unread-count')).json.count;
r = await api(ss.token, 'POST', `/leads/${leadId}/comments`, { body: 'Notif test: customer wants evening calls' });
assert(r.status === 201, 'assignee comments');
const after = (await api(manager.token, 'GET', '/notifications/unread-count')).json.count;
assert(after > before, `manager notified about the comment (${before} → ${after})`);
const adminNotifs = (await api(admin.token, 'GET', '/notifications?unread=true')).json;
const commentNotif = adminNotifs.find((n) => n.type === 'LEAD_COMMENT' && n.leadId === leadId);
assert(!!commentNotif, 'admin got the comment notification with leadId');
const ssUnread = (await api(ss.token, 'GET', '/notifications?unread=true')).json;
assert(!ssUnread.some((n) => n.type === 'LEAD_COMMENT' && n.leadId === leadId), 'actor NOT notified about their own comment');

// Click-to-read: only the clicked one flips
const adminBefore = (await api(admin.token, 'GET', '/notifications/unread-count')).json.count;
r = await api(admin.token, 'POST', `/notifications/${commentNotif.id}/read`);
const adminAfter = (await api(admin.token, 'GET', '/notifications/unread-count')).json.count;
assert(adminAfter === adminBefore - 1, 'clicking marks exactly that notification read');

// Field update notifies watchers
const mBefore = (await api(manager.token, 'GET', '/notifications/unread-count')).json.count;
const interest = fields.find((f) => f.label.startsWith('Product interest'));
if (interest) {
  await api(admin.token, 'PUT', `/leads/${leadId}/custom-values`, { fieldId: interest.id, value: 'Auto' });
  const mAfter = (await api(manager.token, 'GET', '/notifications/unread-count')).json.count;
  assert(mAfter > mBefore, 'field update notifies watchers');
}

// ── Provider daily request limit ──
const providers = (await api(admin.token, 'GET', '/providers')).json;
const mock = providers.find((p) => p.code === 'MOCK');
r = await api(admin.token, 'GET', `/providers/${mock.id}`);
assert(r.status === 200 && r.json.usage && typeof r.json.usage.callsToday === 'number', `provider detail with usage (${r.json.usage.callsToday} calls today)`);
// With limit = callsToday + 1: the next live call is allowed, the one after blocked
await api(admin.token, 'PATCH', `/providers/${mock.id}`, { dailyRequestLimit: r.json.usage.callsToday + 1 });
r = await api(agent.token, 'POST', '/search', { lastName: `Limit${suffix}` }); // uncached live call — uses the last slot
assert(r.status === 201 || r.status === 200, 'call within limit allowed');
r = await api(agent.token, 'POST', '/search', { lastName: `Blocked${suffix}` }); // next live call — over limit
assert(r.status === 503 && /request limit/i.test(r.json.message), 'daily API request limit enforced');
await api(admin.token, 'PATCH', `/providers/${mock.id}`, { dailyRequestLimit: 0 });
r = await api(agent.token, 'POST', '/search', { lastName: 'Garcia' });
assert(r.status === 201 || r.status === 200, 'limit lifted — search works again');

console.log(process.exitCode ? '\nSTATUS/NOTIF TESTS FAILED' : '\nSTATUS/NOTIF TESTS PASSED');
