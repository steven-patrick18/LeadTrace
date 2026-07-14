/**
 * Populates the local system with realistic demo data in EVERY area, going
 * through the real APIs so all invariants and audit trails hold:
 * leads in every status/tier, pending queue rows (T1/T2/T3), calls, notes,
 * comments, custom-field values, enrichments (incl. DNC-blocked), internal
 * DNC entries, desk sessions incl. a takeover, notifications, search cache
 * and provider usage.
 *
 * Run any time:  node scripts/demo-data.mjs   (dev server must be running)
 */
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
  if (!res.ok && res.status !== 409) {
    console.warn(`  ! ${method} ${path} -> ${res.status}`, typeof json === 'object' ? json?.message : '');
  }
  return { status: res.status, json };
}
async function login(email) {
  const r = await api(null, 'POST', '/auth/login', { email, password: PASS });
  if (!r.json.accessToken) throw new Error(`login failed for ${email}`);
  return { token: r.json.accessToken, user: r.json.user };
}
const log = (m) => console.log(`• ${m}`);

const admin = await login('admin@leadtrace.local');
const manager = await login('manager@leadtrace.local');
const agent = await login('agent@leadtrace.local');
const agent2 = await login('agent2@leadtrace.local');
const ss = await login('sragent@leadtrace.local');
const ss2 = await login('sragent2@leadtrace.local');
const closer = await login('closer@leadtrace.local');

// ── Desk sessions: the floor sits down ────────────────────────
await api(agent.token, 'POST', '/desks/clock-in', { batchCode: 'DESK-01' });
await api(agent2.token, 'POST', '/desks/clock-in', { batchCode: 'DESK-02' });
await api(ss.token, 'POST', '/desks/clock-in', { batchCode: 'DESK-03' });
await api(ss2.token, 'POST', '/desks/clock-in', { batchCode: 'DESK-04' });
await api(closer.token, 'POST', '/desks/clock-in', { batchCode: 'DESK-05' });
log('floor clocked in (DESK-01..05)');

// A takeover for the history: closer sits at the agent's seat, then goes back
await api(closer.token, 'POST', '/desks/clock-in', { batchCode: 'DESK-01' });
await api(closer.token, 'POST', '/desks/clock-in', { batchCode: 'DESK-05' });
await api(agent.token, 'POST', '/desks/clock-in', { batchCode: 'DESK-01' });
log('desk takeover recorded (Closer took DESK-01, Agent reclaimed it)');

// ── Custom fields (ensure the three demo fields exist) ───────
let fields = (await api(admin.token, 'GET', '/custom-fields')).json;
const ensureField = async (label, body) => {
  let f = fields.find((x) => x.label.startsWith(label));
  if (!f) {
    f = (await api(admin.token, 'POST', '/custom-fields', body)).json;
  }
  return f;
};
const fInterest = await ensureField('Product interest', {
  label: 'Product interest', fieldType: 'DROPDOWN', options: ['Life insurance', 'Auto', 'Home', 'Bundle'], sortOrder: 0,
});
const fBudget = await ensureField('Monthly budget', { label: 'Monthly budget ($)', fieldType: 'NUMBER', sortOrder: 1 });
const fFollowup = await ensureField('Follow-up date', { label: 'Follow-up date', fieldType: 'DATE', sortOrder: 2 });
log('custom fields ready');

// ── Leads through real searches (fills cache + usage too) ────
async function leadFromSearch(who, query, i) {
  const r = await api(who.token, 'POST', '/search', query);
  const m = r.json?.matches?.[i % Math.max(1, r.json?.matches?.length ?? 1)];
  if (!m) return null;
  const created = await api(who.token, 'POST', '/leads', {
    firstName: m.firstName, lastName: m.lastName, phones: m.phones,
    address: m.address, city: m.city, state: m.state, zip: m.zip,
    sourceProvider: m.sourceProvider, rawProviderData: m, force: true,
  });
  return created.json?.id ?? null;
}

const searches = [
  [agent, { lastName: 'Garcia' }], [agent, { lastName: 'Johnson' }], [agent, { zip: '75201' }],
  [agent, { lastName: 'Martinez' }], [agent2, { lastName: 'Wilson' }], [agent2, { zip: '80202' }],
  [agent2, { lastName: 'Taylor' }], [agent, { lastName: 'Lee' }], [agent2, { lastName: 'White' }],
  [agent, { zip: '30303' }], [agent2, { lastName: 'Lopez' }], [agent, { lastName: 'Harris' }],
];
const leadIds = [];
for (let i = 0; i < searches.length; i++) {
  const [who, q] = searches[i];
  const id = await leadFromSearch(who, q, i);
  if (id) leadIds.push({ id, owner: who });
}
log(`${leadIds.length} leads created from provider searches`);

// A couple of manual leads incl. DNC-demo phones (mock scrub: …7 national DNC, …13 litigator)
const manual = async (who, first, last, phone, city, state, zip) =>
  (await api(who.token, 'POST', '/leads', {
    firstName: first, lastName: last, phones: [{ number: phone }], city, state, zip, force: true,
  })).json?.id;
const dncLead = await manual(agent.token ? agent : agent, 'Nancy', 'Optout', '+13055550117', 'Miami', 'FL', '33101');
const litigatorLead = await manual(agent2, 'Larry', 'Litigious', '+12145550113', 'Dallas', 'TX', '75201');
log('manual leads incl. DNC/litigator demo phones');

// ── Move leads through the funnel ─────────────────────────────
const routeAll = async (point, toUserId, howMany) => {
  const q = (await api(admin.token, 'GET', '/routing/queue')).json;
  const rows = (q[point] ?? []).slice(0, howMany).map((r) => r.id);
  if (rows.length) await api(admin.token, 'POST', '/routing/queue/bulk-route', { queueIds: rows, toUserId });
  return rows.length;
};

// 6 leads: agent requests transfer
for (const { id, owner } of leadIds.slice(0, 6)) {
  await api(owner.token, 'POST', `/routing/leads/${id}/request-transfer`, { note: 'first contact done, interested' });
}
// admin routes 4 to SS (leaves 2 pending in T1 for the queue screen)
await routeAll('T1_TO_SS', ss.user.id, 2);
await routeAll('T1_TO_SS', ss2.user.id, 2);
log('T1 routed (2 left pending for the queue screen)');

// SS works them: calls + notes, 3 request transfer to closer
const ssLeads = leadIds.slice(0, 4);
for (const [i, { id }] of ssLeads.entries()) {
  const w = i % 2 === 0 ? ss : ss2;
  await api(w.token, 'POST', `/leads/${id}/activities`, { type: 'CALL', detail: ['Connected — qualified, wants a quote', 'Callback scheduled for Friday', 'Spouse decides too, call evenings', 'Very warm, ready for closer'][i] });
  if (i < 3) await api(w.token, 'POST', `/routing/leads/${id}/request-transfer`, {});
}
await routeAll('T2_TO_CLOSER', closer.user.id, 2); // 1 stays pending in T2

// Closer: 1 won, 1 lost… then bring one more through and send it back
const closerLeads = ssLeads.slice(0, 2);
if (closerLeads[0]) {
  await api(closer.token, 'POST', `/leads/${closerLeads[0].id}/activities`, { type: 'CALL', detail: 'Final call — signed the bundle!' });
  await api(closer.token, 'POST', `/routing/leads/${closerLeads[0].id}/close`, { outcome: 'CLOSED_WON', note: 'signed 24-month bundle' });
}
if (closerLeads[1]) {
  await api(closer.token, 'POST', `/leads/${closerLeads[1].id}/activities`, { type: 'CALL', detail: 'Went with a competitor' });
  await api(closer.token, 'POST', `/routing/leads/${closerLeads[1].id}/close`, { outcome: 'CLOSED_LOST', note: 'price' });
}
log('closer outcomes: 1 WON (stays with closer for post-sale), 1 LOST');

// A send-back sitting in T3
const third = ssLeads[2];
if (third) {
  const q = (await api(admin.token, 'GET', '/routing/queue')).json;
  const row = (q.T2_TO_CLOSER ?? []).find((r) => r.lead.id === third.id);
  if (row) {
    await api(admin.token, 'POST', `/routing/queue/${row.id}/route`, { toUserId: closer.user.id });
    await api(closer.token, 'POST', `/routing/leads/${third.id}/send-back`, { reason: 'not ready — needs another warm-up round' });
  }
}
log('one send-back waiting in T3');

// ── Custom field values + comments on worked leads ───────────
const interests = ['Bundle', 'Life insurance', 'Auto', 'Home'];
for (const [i, { id, owner }] of leadIds.slice(0, 6).entries()) {
  await api(admin.token, 'PUT', `/leads/${id}/custom-values`, { fieldId: fInterest.id, value: interests[i % 4] });
  await api(admin.token, 'PUT', `/leads/${id}/custom-values`, { fieldId: fBudget.id, value: String(150 + i * 75) });
  await api(admin.token, 'PUT', `/leads/${id}/custom-values`, { fieldId: fFollowup.id, value: '2026-07-21' });
  await api(owner.token, 'POST', `/leads/${id}/comments`, { body: 'Customer confirmed contact details on first call.' });
  if (i % 2 === 0) await api(manager.token, 'POST', `/leads/${id}/comments`, { body: 'Priority — this segment converts well.' });
}
log('custom fields filled + comments added');

// ── Enrichment across the board ───────────────────────────────
for (const { id } of leadIds.slice(0, 5)) {
  await api(admin.token, 'POST', `/leads/${id}/enrich`);
}
if (dncLead) await api(agent.token, 'POST', `/leads/${dncLead}/enrich`);
if (litigatorLead) await api(agent2.token, 'POST', `/leads/${litigatorLead}/enrich`);
log('7 leads enriched (incl. one national-DNC and one litigator block)');

// ── Internal DNC entries ──────────────────────────────────────
await api(manager.token, 'POST', '/dnc', { phone: '+13055550166', reason: 'Asked for removal — postcard reply 2026-07-01' });
await api(manager.token, 'POST', '/dnc', { phone: '+18135550244', reason: 'Verbal opt-out during call 2026-07-10' });
log('internal DNC opt-out entries added');

// ── Calls logged from desks (attributed to seats) ─────────────
for (const { id, owner } of leadIds.slice(6, 9)) {
  await api(owner.token, 'POST', `/leads/${id}/activities`, { type: 'CALL', detail: 'Intro call — left voicemail' });
  await api(owner.token, 'POST', `/leads/${id}/activities`, { type: 'NOTE', detail: 'Try again after 5pm local time' });
}
log('intro calls + notes logged from desks');

// ── Work statuses: each assignee sets one from their tier's list ─────
const statusLists = (await api(admin.token, 'GET', '/tier-statuses')).json;
const allLeads = (await api(admin.token, 'GET', '/leads?scope=all&pageSize=100')).json.items;
const tokenByUserId = {
  [agent.user.id]: agent.token, [agent2.user.id]: agent2.token,
  [ss.user.id]: ss.token, [ss2.user.id]: ss2.token, [closer.user.id]: closer.token,
};
let statusesSet = 0;
for (const [i, l] of allLeads.entries()) {
  if (l.workStatus || !l.assignedTo) continue;
  if (['CLOSED_WON', 'CLOSED_LOST', 'PENDING_ROUTING'].includes(l.status) && l.status !== 'CLOSED_WON') continue;
  const token = tokenByUserId[l.assignedTo.id];
  const list = statusLists[l.currentTier] ?? [];
  if (!token || !list.length) continue;
  const pick = list[i % list.length];
  const res = await api(token, 'PUT', `/leads/${l.id}/work-status`, { statusId: pick.id });
  if (res.status === 200) statusesSet++;
  if (statusesSet >= 10) break;
}
log(`work statuses set on ${statusesSet} leads`);

console.log('\nDemo data complete. Log in as any user to explore:');
console.log('  admin@ manager@ agent@ agent2@ sragent@ sragent2@ closer@leadtrace.local /', PASS);
