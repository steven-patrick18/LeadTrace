# LeadTrace

Search-to-lead CRM for a calling/sales operation. Operators search people through
licensed data providers (phone / name / zip), convert matches to leads in one click,
and every lead travels a three-tier call chain — **Agent → Sr Agent (SS) → Closer** —
with **every transfer decided by the Admin** through a routing queue. All visibility
and actions flow from a **role-permission matrix** the Admin edits at runtime.

Built to `LeadTrace_Claude_Build_Spec.md` (authoritative) — see that file for the
full product spec.

## Stack

- **Backend** [`backend/`](backend): NestJS + TypeScript + Prisma + PostgreSQL 15.
  Cache/sessions: Redis (`REDIS_URL`), with an automatic in-memory fallback for
  single-instance dev.
- **Frontend** [`frontend/`](frontend): React + TypeScript + Vite.
- **Auth**: JWT access/refresh with rotation; sessions tracked in the cache layer.

## Quick start (dev)

```bash
# prerequisites: Node 20+, PostgreSQL 15+ running locally
cd backend
cp .env.example .env            # fill in DATABASE_URL etc. (dev .env already present here)
npm install
npx prisma migrate dev          # creates schema + append-only triggers
npx prisma db seed              # 5 roles, permission matrix, demo users, mock provider
npm run start:dev               # API on :3000

cd ../frontend
npm install
npm run dev                     # UI on :5173 (proxies /api to :3000)
```

**Demo users** (password `LeadTrace!Dev1`, or `SEED_USER_PASSWORD` env):
`admin@ · manager@ · agent@ · agent2@ · sragent@ · sragent2@ · closer@leadtrace.local`

## Verification

| What | Command |
| --- | --- |
| Type checks | `npx tsc -p backend/tsconfig.build.json --noEmit` / `npx tsc -b frontend` |
| Invariant + permission tests (42) | `cd backend && npm run test:e2e` (needs dev server + DB) |
| Full call-chain smoke (34 checks) | `node backend/scripts/smoke.mjs` (needs dev server) |
| Provider catalog/credential checks | `node backend/scripts/smoke-providers.mjs` (needs dev server) |
| Enrichment module checks (29) | `node backend/scripts/smoke-enrichment.mjs` (needs dev server) |
| Fields/comments/access checks (27) | `node backend/scripts/smoke-fields.mjs` (needs dev server) |
| Desk/batch-ID checks (16) | `node backend/scripts/smoke-desks.mjs` (needs dev server) |
| Quick-session checks (15) | `node backend/scripts/smoke-batch-sessions.mjs` (needs dev server; uses up the demo Agent's rate-limit window) |
| **Demo data (all areas)** | `node backend/scripts/demo-data.mjs` — leads in every status/tier, queue rows, calls, comments, fields, enrichments, DNC, desk sessions |
| Lockdown drill | `node backend/scripts/smoke-lockdown.mjs` (needs dev server; briefly locks the system!) |

## Architecture notes

### Permission system (built first — everything hangs off it)

- `permissions(role_id, permission_key, allowed, scope)`, scope ∈ `ALL | OWN | ASSIGNED | VIEW`.
- Every endpoint declares `@RequirePermission('key')`; a global guard resolves the
  caller's role permissions from DB (Redis/memory cached, invalidated on every matrix
  edit). **An endpoint with no declared permission is denied by design** (fail closed).
- The Admin edits the matrix at Permissions → click a cell to cycle
  denied → ALL → OWN → ASSIGNED → VIEW → denied. Changes are audited and take
  effect immediately — e.g. granting `route_leads` to MANAGER enables Manager
  routing with **zero code change**.
- Guard rail: the ADMIN role cannot lose `manage_permissions` or `system_lockdown`.

### Call chain invariants (spec §4 — all tested)

1. `leads.assigned_to` / `current_tier` change **only** inside
   `RoutingService.routeOne()` (behind `route_leads`), plus initial assignment at
   lead creation. Proven by a static source scan in `backend/test/invariants.e2e-spec.ts`.
2. `routing_history` and `audit_log` are **append-only, enforced by PostgreSQL
   triggers** (`backend/prisma/migrations/*_append_only_guards`) — UPDATE/DELETE
   raise an exception for any client, including raw SQL.
3. Phones are E.164 (`libphonenumber-js`, invalid numbers rejected).
   `search_cache.search_key` is a lowercased, key-sorted representation, so
   equivalent searches share one cache row.
4. Closed leads re-enter the flow only via the Admin **Reopen** action (audited).

### Data providers & accuracy

- One interface (`PersonDataProvider`) → one normalized match shape with a
  0–100 **confidence score** surfaced in the UI.
- The **Providers page** (Admin, `manage_providers`) ships a catalog — Mock,
  Endato/Enformion, Trestle, idiCORE, BatchData, Melissa, plus custom entries —
  each with step-by-step "how to get access" instructions, sign-up/docs links,
  API-credential storage, cost/cap/TTL config, and Activate/Deactivate.
  Exactly one provider is active at a time.
- **Credentials never reach the browser**: keys are write-only via the API; GET
  returns only presence + last 4 characters. Values are never audit-logged.
- Activation is triple-guarded: saved credentials + recorded permitted-use
  attestation + an implemented adapter (register new adapters in
  `backend/src/providers/provider.registry.ts` — no other file changes).
- `MOCK` ships active (deterministic synthetic data, $0, reserved 555-01XX
  numbers) so development and training cost nothing.
- **Cache-first, always**: repeat searches cost $0; per-provider daily spend caps
  block overruns; the API-costs report shows live calls vs cache hits.
- **Compliance (spec §8)**: provider data is for sales lead-generation only.
  No feature may use it for credit, employment, insurance, or tenant-screening
  decisions (FCRA / DPPA / GLBA restricted).

### Quick batch-ID sessions (mid-call takeover, no logout)

The call stays live on the Agent's machine — only the LEAD moves up the chain.
When the Sr Agent / Closer / Manager walks over to that machine:

1. Every user has a personal **batch ID** (shown under ⚡ Session → "My batch
   ID"; demo: `LT-AMY`, `LT-ANDY`, `LT-SAM`, `LT-SARA`, `LT-CARL`, `LT-MARK`,
   `LT-ALICE`). Admin can rotate any user's ID from the Users API if it leaks.
2. They click **⚡ Session** in the top bar and type THEIR batch ID — the
   screen instantly works as them (their permissions, their name on every
   update) with no logout/login.
3. The session lasts the **admin-set duration** (Settings → "Quick-session
   duration", default 30 min), counts down in an amber banner, and
   **auto-logs out** — the screen returns to the original login automatically.
   "End session" finishes early. Expiry is enforced server-side (short-lived
   token + session TTL), not just in the browser.
4. **Visibility**: the identity owner is notified the moment their batch ID is
   used, sees every active session under their identity in the ⚡ Session
   panel ("on Amy Agent's screen · until 3:41 PM"), and can **revoke** any of
   them instantly. Admins can revoke too. All starts/ends/revokes are audited,
   and bad batch-ID guesses are rate-limited (5 / 15 min).

### Batch-ID desk sessions (shared-seat call floor)

- Everyone logs in with their **own account**; sitting down means typing the
  desk's **batch ID** (e.g. `DESK-01`) into the top-bar widget to clock in.
- **Takeover**: if a Closer or Manager sits at an occupied seat and enters its
  batch ID, the previous session is force-completed as a TAKEOVER, the previous
  user is notified, and the event is audited. Switching seats auto-closes your
  old session.
- **Force complete**: an admin can end any open session from the Desk Floor
  page (`manage_desks`; Manager has VIEW — sees the floor, can't manage it).
- **Call attribution**: calls are tagged with the caller's desk session when
  clocked in. Requiring a seat for calls is an admin setting
  (`require_desk_for_calls`, off by default so quick sessions flow freely).
- Seeded desks: `DESK-01` … `DESK-06`; admins add more on the Desk Floor page.

### Custom fields, comments, per-lead access

- **One editable lead card**: contact details (name, primary phone, address)
  and the admin-defined process fields live in a single "Lead details" card,
  all inline-editable under the `edit_lead` permission + scope (OWN /
  ASSIGNED / ALL); read-only otherwise. Admins add new form fields right on
  the lead page or in Settings (text / number / date / dropdown). Phone edits
  are E.164-validated; every change is written to the lead timeline and the
  audit log. Deactivating a field hides it without losing data.
- **Comments** (`comment_lead`): writable by the Manager, the Admin, and the
  people who actually worked the lead (creator, assignee, routed to/from it,
  or logged activity on it) — enforced server-side, not by role name.
- **Post-sale at the Closer**: a CLOSED_WON lead stays assigned to its Closer
  and remains open for comments, notes, and field updates — winning ends the
  call chain, not the work.
- **Per-lead access revocation** (`manage_lead_access`, Admin): the admin can
  revoke any person's access to a specific lead — it disappears from their
  lists, detail view, edits, call logging, enrichment, and comments. Admins
  are immune (no self-lockout), and every revoke/restore is audited.

### Reports & user oversight

- **Reports page** (`view_reports_team`): preset windows (7/30/90/365 days)
  or a **custom from–to date range** — leads created, calls made, win rate,
  average time-to-route, funnel, pipeline snapshot by status/tier, activity
  volume per day, and a per-user performance table with win rates. CSV
  exports (leads + performance) behind `export_data`.
- **Everything drills down**: dashboard status tiles, funnel bars, queue
  health, pipeline rows, and per-user rows are clickable — they land on the
  leads list pre-filtered (filters live in the URL: `?status=`, `?tier=`,
  `?assignedTo=`) or on the user's page.
- **User pages** (`/users/:id`, opened by clicking a user anywhere): full
  profile editing — name, email, role, password reset, activate/deactivate —
  plus **batch-ID assignment** (set a custom code or 🎲 random; duplicates
  rejected), performance with win rate, live desk status, assigned leads,
  and recent activity. Batch IDs are masked for VIEW-scope managers.

### Lead enrichment (sections A/C/D/E)

- **Manual trigger**: "Enrich" on the lead detail page (`enrich_lead`). Runs
  licensed-provider data (A, cache-first, mock in dev) → free geo (C, offline
  tables; swap in USPS/Census adapters) → compliance scrub (D) → in-house
  intelligence (E). Partial failures save what succeeded (`PARTIAL`).
- **Hard scope rules, enforced by static tests**: no scraping, no photo
  fetching/face matching, no biometrics; social data is provider-returned URL
  strings only, displayed as links, never fetched; census stats are area-level
  and labeled as such.
- **The DNC gate**: the in-house `dnc_optout` table (Manager/Admin, "DNC List"
  page) is authoritative and checked live on every CALL log — external
  national/state DNC + litigator flags come from the pluggable scrub (mock in
  dev; deterministic: numbers ending in 7 → national DNC, 4 → state, "13" →
  litigator). `callable=false` ⇒ red DO-NOT-CALL banner, server refuses the
  CALL with reasons, and the attempt is audited (`CALL_BLOCKED_DNC`).
- **Lead score** is a transparent weighted sum (weights Admin-editable in
  Settings; every run stores its itemized breakdown, so scores are reproducible).
  Not-callable leads are hard-capped. **Conversion probability** is a documented
  heuristic (score blend + the org's own win rate); a Phase-2 model trained on
  this client's CLOSED_WON/LOST history can replace it, but the heuristic
  fallback stays.
- **Cost control**: $25/day cap (`enrichment_daily_cap_cents`) pauses paid
  enrichment on breach (free geo + scoring keep running, admins alerted);
  30-day cache TTL (`enrichment_cache_ttl_hours`) makes re-enrich free;
  spend visible in API Costs (`view_enrichment_cost`).

### Break-glass lockdown (spec §7) — runbook

1. **Before you ever need it**: Settings → generate the recovery key
   (`WK-XXXX-XXXX-XXXX-XXXX`). It is shown **once**; keep it on paper. Only the
   argon2 hash is stored. Regenerating kills the old key.
2. **Trigger**: Settings → LOCKDOWN SYSTEM (double confirmation). The entire
   system — including your own session — returns an empty 503. Browsers show a
   connection failure. Background jobs and provider calls pause.
3. **Wake**: open `https://<host>/__wake-<LOCKDOWN_WAKE_SLUG>` (slug from env,
   never linked in-app), enter the key. Success → system ACTIVE, redirect to
   login. Wrong keys get a generic error; 5 attempts / 15 min per IP with
   incremental delay; ~25 global failures lock the wake endpoint for an hour.
4. **Console fallback** (paper key lost — requires direct DB access):

   ```sql
   UPDATE system_state SET status='ACTIVE' WHERE id=1;
   ```

   Then rotate `LOCKDOWN_WAKE_SLUG` and regenerate the recovery key.

   Note: the spec asks for a ≥128-bit key in the `WK-` 4×4 format; 16 chars of a
   30-char alphabet is ~78 bits. Combined with argon2 verification, per-IP rate
   limiting, and the global endpoint lockout, online brute force is not feasible.
   If offline-grade entropy is required, lengthen the format in
   `lockdown.service.ts` (`KEY_ALPHABET` / group count).

### Audit

Append-only `audit_log` records: login (+failures), lead create/update, transfer
requests, **every routing decision**, closes, reopens, permission changes, role
renames, user admin, provider changes, spend-cap hits, recovery-key generation,
lockdown, wake attempts (success, failure, rate-limited).

## Production checklist

- Set strong `JWT_ACCESS_SECRET` / `JWT_REFRESH_SECRET`, a fresh
  `LOCKDOWN_WAKE_SLUG`, and `REDIS_URL` (required for multi-instance).
- Change all seeded passwords; HTTPS only; restrict DB access (append-only
  triggers protect history even from the app role, but not from superusers).
- Wire a real provider adapter + attestation before granting `search_providers`
  to real operators; set `costPerSearchCents` + `dailySpendCapCents`.
- Add Meilisearch/Typesense if lead volume outgrows Postgres search
  (`LeadsService.list` is the single seam to swap).
