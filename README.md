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
