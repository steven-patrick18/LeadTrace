# LeadTrace — Build Spec for Claude (Fable 5 / Claude Code)

**How to use:** Paste or attach this file as the project brief in Claude Code. It is the authoritative spec. Build in the phases given, in order. Where this file says "no exceptions," enforce it in code and tests, not just intention. Ask the user the questions in §10 before writing code.

---

## 0. Product in one paragraph

LeadTrace is a web CRM for a calling/sales operation. Operators search people through licensed data providers (phone / first+last name / zip), convert a match to a lead in one click, and the lead travels a three-tier call chain — **Agent → Sr Agent (SS) → Closer** — where the deal is finalized (**the call flow ends at the Closer**). **Every transfer between tiers is decided by the Admin** through a routing queue. The **Manager oversees everything** (all leads, dashboards, reports) without touching routing. All visibility and actions are controlled by a **role-permission matrix** the Admin can edit — e.g., reports are visible to Manager and Admin because the permission matrix says so, not because it's hard-coded.

---

## 1. Stack

- **Backend:** NestJS + TypeScript + Prisma. (Django+DRF acceptable if user prefers.)
- **DB:** PostgreSQL 15+. **Cache/sessions:** Redis. **Lead search:** Meilisearch or Typesense.
- **Frontend:** React + TypeScript.
- **Auth:** JWT access/refresh; sessions tracked in Redis (required for lockdown).

---

## 2. Roles (renameable) and the call chain

Five roles. Display names live in the DB and are renameable; permissions bind to `role_code`.

| role_code | Default name | Tier |
|---|---|---|
| `AGENT` | Agent | 1 — first contact |
| `SR_AGENT` | Sr Agent / SS | 2 — qualify / warm-up |
| `CLOSER` | Closer | 3 — final call, **deal closes here** |
| `MANAGER` | Manager | oversight of everything |
| `ADMIN` | Admin | all access + routing authority |

**Call chain:** Agent → (Admin routes) → SS → (Admin routes) → Closer → CLOSED_WON / CLOSED_LOST. Send-backs also pass through the Admin.

---

## 3. Permission system — build this FIRST

Everything else depends on it.

- Table: `permissions(role_id, permission_key, allowed, scope)` where scope ∈ `ALL | OWN | ASSIGNED`.
- **Server-side guard on every endpoint**, declaring its required `permission_key`. Resolve from DB with Redis caching; invalidate cache when Admin edits permissions.
- Admin UI: a matrix editor (roles × permissions, toggle cells).
- Seed with this default matrix:

| permission_key | AGENT | SR_AGENT | CLOSER | MANAGER | ADMIN |
|---|---|---|---|---|---|
| search_providers | ✅ | ✅ | ❌ | ✅ | ✅ |
| create_lead | ✅ | ✅ | ❌ | ✅ | ✅ |
| view_own_leads | ✅ | ✅ | ✅ | ✅ | ✅ |
| view_all_leads | ❌ | ❌ | ❌ | ✅ | ✅ |
| edit_lead | OWN | ASSIGNED | ASSIGNED | ALL | ALL |
| log_activity | ✅ | ✅ | ✅ | ✅ | ✅ |
| request_transfer | ✅ | ✅ | ❌ | ✅ | ✅ |
| route_leads | ❌ | ❌ | ❌ | ❌ | ✅ |
| close_deal | ❌ | ❌ | ✅ | ✅ | ✅ |
| send_back | ❌ | ❌ | ✅ | ✅ | ✅ |
| view_reports_team | ❌ | ❌ | ❌ | ✅ | ✅ |
| view_reports_own | ✅ | ✅ | ✅ | ✅ | ✅ |
| view_api_costs | ❌ | ❌ | ❌ | ✅ | ✅ |
| export_data | ❌ | ❌ | ❌ | ✅ | ✅ |
| manage_users | ❌ | ❌ | ❌ | VIEW | ✅ |
| manage_permissions | ❌ | ❌ | ❌ | ❌ | ✅ |
| manage_providers | ❌ | ❌ | ❌ | ❌ | ✅ |
| system_lockdown | ❌ | ❌ | ❌ | ❌ | ✅ |

Note `route_leads` = ADMIN only by default, but it is a permission — the client can grant it to MANAGER later through the UI with **zero code change**. Build it that way.

---

## 4. Data model

```
roles(id, role_code UNIQUE, display_name, tier INT NULL, created_at)
permissions(id, role_id FK, permission_key, allowed BOOL, scope ENUM[ALL,OWN,ASSIGNED])
users(id, name, email UNIQUE, password_hash, role_id FK, reports_to FK NULL, is_active, created_at)

leads(id, created_by FK, assigned_to FK NULL,
      current_tier ENUM[AGENT,SR_AGENT,CLOSER],
      status ENUM[NEW,PENDING_ROUTING,IN_PROGRESS,QUALIFIED,CLOSED_WON,CLOSED_LOST,INVALID],
      first_name, last_name, primary_phone, address, city, state, zip,
      source_provider, raw_provider_data JSONB, created_at, updated_at)

lead_phones(id, lead_id FK, phone E164, line_type, is_primary)

routing_queue(id, lead_id FK,
      transfer_point ENUM[T1_TO_SS, T2_TO_CLOSER, T3_SEND_BACK],
      raised_by FK, status ENUM[PENDING,ROUTED],
      routed_by FK NULL, routed_to FK NULL, created_at, routed_at)

routing_history(id, lead_id, transfer_point, from_user, to_user, routed_by, created_at)  -- APPEND-ONLY

activities(id, lead_id FK, user_id, type ENUM[CALL,NOTE,STATUS_CHANGE,TRANSFER_REQUEST], detail, created_at)

search_cache(id, search_key UNIQUE, provider, response JSONB, created_at, expires_at)
audit_log(id, user_id NULL, action, detail JSONB, ip, created_at)  -- APPEND-ONLY

system_state(id=1, status ENUM[ACTIVE,LOCKED], updated_by, updated_at)
recovery_key(id, key_hash, created_by, created_at, is_active)
```

**Invariants (write tests for each):**
1. `leads.assigned_to` and `leads.current_tier` change **only** inside a routing action performed by a user with `route_leads`. No other code path may mutate them.
2. `routing_history` and `audit_log` are append-only.
3. Phone numbers stored E.164; `search_cache.search_key` is a normalized (lowercased, sorted) representation of the query so equivalent searches hit the same row.
4. A lead in `CLOSED_WON/CLOSED_LOST` cannot re-enter the queue except by an Admin "reopen" action (logged).

---

## 5. Lead lifecycle — exact transitions

```
1. AGENT creates lead        → status NEW, tier AGENT, assigned_to = creator
2. AGENT "Request Transfer"  → status PENDING_ROUTING, queue row T1_TO_SS
3. ADMIN routes to an SS     → tier SR_AGENT, status IN_PROGRESS, history row
4. SS "Request Transfer"     → status PENDING_ROUTING, queue row T2_TO_CLOSER
5. ADMIN routes to a Closer  → tier CLOSER, status IN_PROGRESS, history row
6. CLOSER:
     Close Won  → CLOSED_WON   (end)
     Close Lost → CLOSED_LOST  (end)
     Send Back  → PENDING_ROUTING, queue row T3_SEND_BACK → Admin re-routes down
```

Every transition writes an `activities` row. The **conversion funnel report** (Agent→SS→Closer→Won) reads directly from `routing_history` + closes.

---

## 6. Build phases (in order; each phase working before the next)

**Phase 1 — Foundation:** scaffold, migrations, seed roles + permission matrix, auth, the permission guard.

**Phase 2 — Search & leads:** provider abstraction (`searchPerson({phone?,name?,zip?})` → one normalized shape `{firstName,lastName,phones[],address,city,state,zip,ageRange,relatives[],confidence,sourceProvider}`); **mock provider first** so no money is spent in dev; cache-first, always; search UI with preview cards; one-click Add to Lead with duplicate-phone warning; Meilisearch index.

**Phase 3 — Call chain & routing:**
- Request Transfer (Agent, SS).
- **Admin Routing Queue** screen: PENDING rows grouped by transfer point (T1/T2/T3), wait time per row, pick recipient, **bulk routing** (multi-select → one recipient). Bulk routing is required, not optional — the Admin touches every lead.
- Tier views: Agent "My Leads", SS "My Leads", Closer "My Leads" (with Close Won / Close Lost / Send Back).
- Activities timeline per lead.
- Safeguards: a second user can hold `route_leads` (backup admin); aging alert (PENDING older than configurable threshold → flag + notify).

**Phase 4 — Manager oversight & reports:**
- Manager dashboard: all leads by tier/status, conversion funnel, per-user performance, lead aging.
- Reports respect `view_reports_team` vs `view_reports_own` — an Agent sees only their own numbers; Manager and Admin see everything. This must flow from the permission matrix, not hard-coded role checks.
- Provider usage/cost report; CSV/Excel export behind `export_data`.
- User management + the permission matrix editor.

**Phase 5 — Break-glass lockdown:** exact behavior below.

---

## 7. Lockdown — exact behavior (no deviations)

1. **Recovery key pre-generated** in Settings before lockdown can be used. ≥128-bit random, format `WK-XXXX-XXXX-XXXX-XXXX`, shown ONCE, store argon2 hash only. Regenerate = old key dead. Lockdown button disabled until an active key exists.
2. **State flag** in `system_state` (DB is source of truth; short-TTL Redis cache OK).
3. **Trigger:** endpoint behind `system_lockdown`; frontend confirmation with explicit warning ("blacks out the ENTIRE system including your own session").
4. **Blackout gate:** middleware before auth and routing. When LOCKED → empty `503`, no body, no identifying headers → browser shows "connection failed." **Applies to every session including the Admin's.**
5. **Sole exception — wake URL:** path from env `LOCKDOWN_WAKE_SLUG` (e.g. `/__wake-x7f9q2`), never linked in-app. Bare unbranded page: key input + submit.
6. **Wake:** argon2 verify → set ACTIVE → audit → redirect to login. Wrong key → generic error, no hints.
7. **Brute-force protection:** IP rate limit (5/15min default), incremental delay, log every attempt; heavy failure count locks the endpoint (console recovery remains).
8. **Console fallback** documented in README: `UPDATE system_state SET status='ACTIVE' WHERE id=1;` — requires direct DB access; last resort if the paper key is lost.
9. During lockdown: DB + web server stay up (to serve wake URL); pause background jobs and provider API calls.
10. **Test in staging:** admin truly loses access; correct key wakes; wrong keys rate-limited; console fallback works.

---

## 8. Compliance guardrails

- Provider data is for **sales lead-gen only**. Do not build any feature that uses it for credit, employment, insurance, or tenant-screening decisions (FCRA/DPPA/GLBA restricted).
- Record a permitted-use attestation in provider settings.

---

## 9. Definition of done (every phase)

- Permission guard on every endpoint, with tests per permission_key.
- Invariant tests from §4 pass (especially: no path mutates `assigned_to` outside routing).
- No secrets in code; env vars only.
- Provider calls are cache-first; mock provider used in dev/test.
- Audit log entries for: login, lead create, transfer request, **every routing decision**, close, permission change, lockdown/wake.
- CI green (lint, unit, integration) before merge.

---

## 10. Ask the user before coding

1. Confirm stack (NestJS default).
2. First real data provider + credentials, or start fully on the mock?
3. Send-backs: always through the Admin queue (spec default), or may a Closer return directly to a chosen SS?
4. Notifications v1: in-app only, or email/WhatsApp?
5. Expected daily lead volume (sizes queue UX + infra).
6. Final product name (LeadTrace is a working name).
