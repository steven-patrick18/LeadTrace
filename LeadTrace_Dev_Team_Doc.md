# LeadTrace — Development Team Documentation

**Version:** 2.0 (call-flow hierarchy)
**Audience:** Development team
**Status:** Approved for build

---

## 1. Product summary

LeadTrace is a search-to-lead CRM for a calling/sales operation. Operators find people through licensed data providers (search by phone, name, or zip), convert matches to leads in one click, and work each lead through a **three-tier call chain** — Agent → Sr Agent (SS) → Closer — where the deal is finalized. The Admin controls every transfer between tiers; the Manager oversees all operations; access to everything (screens, actions, reports) is governed by a role-permission system.

---

## 2. Roles & hierarchy

Five roles. Display names are **renameable** in settings; permissions bind to the stable `role_code`.

| role_code | Default name | Level | What they do |
|---|---|---|---|
| `AGENT` | Agent | Tier 1 | Searches providers, creates leads, makes the first call/contact. |
| `SR_AGENT` | Sr Agent / SS | Tier 2 | Second-stage calling: qualifies, warms up, builds interest. |
| `CLOSER` | Closer | Tier 3 (final) | Final call. Deal closes here — **the call flow ends at the Closer.** |
| `MANAGER` | Manager | Oversight | Manages everything operationally: monitors all leads, all tiers, team performance, reports. Does not need to touch individual routing. |
| `ADMIN` | Admin | Full access | Everything the Manager has **plus** routing authority on every transfer, user management, role permissions, provider/API settings, billing, system lockdown. |

### Call flow (the money path)

```
  AGENT              SR AGENT (SS)           CLOSER
  first contact  →   qualify / warm-up   →   final call
                                              DEAL CLOSES HERE
       │                   │                      │
       └────── every transfer routed by ADMIN ────┘

  MANAGER  — watches all of it (dashboards, reports, team mgmt)
  ADMIN    — all access + routing + system control
```

### Transfer points (all Admin-routed)

| # | Trigger | Admin decides |
|---|---|---|
| T1 | Agent creates a lead / finishes first contact | Which **Sr Agent (SS)** receives it |
| T2 | Sr Agent marks lead as qualified/ready | Which **Closer** receives it |
| T3 | A lead is sent back down (not ready / wrong fit) | Who re-works it (back to SS or Agent) |

**Routing authority is permission-driven, not hard-coded.** Ship with `route_leads` granted to `ADMIN` only. If the client later wants the Manager to route, the Admin grants `route_leads` to `MANAGER` in settings — zero code change.

---

## 3. Permission system (build this first, everything hangs off it)

A permission matrix: `role_code × permission_key → allowed`. Stored in DB, editable by Admin in a settings screen, enforced **server-side on every endpoint**.

### Permission keys (initial set)

| permission_key | AGENT | SR_AGENT | CLOSER | MANAGER | ADMIN |
|---|---|---|---|---|---|
| `search_providers` | ✅ | ✅ | ❌ | ✅ | ✅ |
| `create_lead` | ✅ | ✅ | ❌ | ✅ | ✅ |
| `view_own_leads` | ✅ | ✅ | ✅ | ✅ | ✅ |
| `view_all_leads` | ❌ | ❌ | ❌ | ✅ | ✅ |
| `edit_lead` | own | assigned | assigned | ✅ | ✅ |
| `log_activity` (calls/notes) | ✅ | ✅ | ✅ | ✅ | ✅ |
| `request_transfer` (push lead up) | ✅ | ✅ | ❌ | ✅ | ✅ |
| `route_leads` (decide transfers) | ❌ | ❌ | ❌ | ❌* | ✅ |
| `close_deal` (Won/Lost) | ❌ | ❌ | ✅ | ✅ | ✅ |
| `send_back` (return lead down-tier) | ❌ | ❌ | ✅ | ✅ | ✅ |
| `view_reports_team` | ❌ | ❌ | ❌ | ✅ | ✅ |
| `view_reports_own` | ✅ | ✅ | ✅ | ✅ | ✅ |
| `view_api_costs` | ❌ | ❌ | ❌ | ✅ | ✅ |
| `export_data` | ❌ | ❌ | ❌ | ✅ | ✅ |
| `manage_users` | ❌ | ❌ | ❌ | view | ✅ |
| `manage_permissions` | ❌ | ❌ | ❌ | ❌ | ✅ |
| `manage_providers` | ❌ | ❌ | ❌ | ❌ | ✅ |
| `system_lockdown` | ❌ | ❌ | ❌ | ❌ | ✅ |

\* configurable — client may grant later.

This table ships as the **seed data**; after that the Admin owns it through the UI. "Reports can be seen by Manager and Admin" is simply the default state of `view_reports_team` — exactly as the client described.

---

## 4. Data model

```
roles
  id, role_code (unique, stable), display_name, tier (int, nullable), created_at

permissions
  id, role_id (fk), permission_key, allowed (bool), scope (enum: ALL, OWN, ASSIGNED)

users
  id, name, email (unique), password_hash, role_id (fk), reports_to (fk users, null),
  is_active, created_at

leads
  id, created_by (fk users), assigned_to (fk users, null),
  current_tier (enum: AGENT, SR_AGENT, CLOSER),
  status (enum: NEW, PENDING_ROUTING, IN_PROGRESS, QUALIFIED, CLOSED_WON, CLOSED_LOST, INVALID),
  first_name, last_name, primary_phone, address, city, state, zip,
  source_provider, raw_provider_data (jsonb), created_at, updated_at

lead_phones
  id, lead_id (fk), phone (E.164), line_type, is_primary

routing_queue          -- every transfer waits here
  id, lead_id (fk), transfer_point (enum: T1_TO_SS, T2_TO_CLOSER, T3_SEND_BACK),
  raised_by (fk users), status (PENDING, ROUTED),
  routed_by (fk users, null), routed_to (fk users, null),
  created_at, routed_at

routing_history        -- append-only chain of every routing decision
  id, lead_id, transfer_point, from_user, to_user, routed_by, created_at

activities             -- every touch
  id, lead_id (fk), user_id, type (CALL, NOTE, STATUS_CHANGE, TRANSFER_REQUEST),
  detail, created_at

search_cache
  id, search_key (unique, normalized), provider, response (jsonb), created_at, expires_at

audit_log              -- append-only
  id, user_id (null), action, detail (jsonb), ip, created_at

system_state           -- lockdown flag, single row
  id (=1), status (ACTIVE | LOCKED), updated_by, updated_at

recovery_key
  id, key_hash (argon2), created_by, created_at, is_active
```

Rules:
- Phones normalized to E.164 on input.
- `routing_history`, `audit_log` append-only — no updates or deletes ever.
- `leads.assigned_to` and `leads.current_tier` change **only** through a routing action by a user holding `route_leads`. No other code path. Write a test that proves it.

---

## 5. Lead lifecycle (states)

```
NEW ──► PENDING_ROUTING ──► IN_PROGRESS (Agent tier already done at creation? No:)
```

Precisely:

1. Agent searches → creates lead → `status = NEW`, `current_tier = AGENT`, `assigned_to = creator`.
2. Agent works it (first contact). When ready, Agent hits **Request Transfer** → `status = PENDING_ROUTING`, row in `routing_queue` (T1).
3. Admin routes → `assigned_to = chosen SS`, `current_tier = SR_AGENT`, `status = IN_PROGRESS`.
4. SS qualifies. When ready → **Request Transfer** → `PENDING_ROUTING`, queue row (T2).
5. Admin routes → `assigned_to = chosen Closer`, `current_tier = CLOSER`, `status = IN_PROGRESS`.
6. Closer finishes: **CLOSED_WON / CLOSED_LOST** (call flow ends here), or **Send Back** → queue row (T3) → Admin re-routes down.

Every state change writes an `activities` row.

---

## 6. Modules & build order

### Phase 1 — Foundation
1. Scaffold (NestJS + Prisma + PostgreSQL + Redis), env config, migrations.
2. `roles`, `permissions`, `users` + seed (5 roles, permission matrix from §3).
3. Auth (JWT + refresh, sessions in Redis).
4. **Permission guard**: every endpoint declares required `permission_key`; guard resolves from DB (cache in Redis, invalidate on permission edit).

### Phase 2 — Search & lead creation
5. Provider abstraction layer (one `searchPerson()` → normalized shape; mock provider for dev; cache-first).
6. Search UI with match preview cards.
7. One-click Add to Lead + duplicate check (phone match warning).
8. Meilisearch/Typesense index over leads.

### Phase 3 — Call chain & routing
9. Request Transfer action (Agent, SS) → queue row.
10. **Admin Routing Queue** screen: pending rows grouped by transfer point, wait-time shown, single + **bulk** routing.
11. My Leads per tier (Agent / SS / Closer views).
12. Closer actions: Close Won / Close Lost / Send Back.
13. Activities: call logs, notes, timeline per lead.
14. Safeguards: backup Admin (second user with `route_leads`), aging alert on `PENDING` rows older than a configurable threshold.

### Phase 4 — Manager oversight & reports
15. Manager dashboard: all leads by tier and status, conversion funnel (Agent→SS→Closer→Won), aging, per-user performance.
16. Reports gated by `view_reports_team` / `view_reports_own`.
17. Provider usage & cost report (`view_api_costs`).
18. Exports (CSV/Excel) gated by `export_data`.
19. User management + permission matrix editor (Admin).

### Phase 5 — System control
20. Break-glass lockdown (see §7).

---

## 7. Break-glass lockdown (summary — full spec exists separately)

- Admin pre-generates a recovery key in Settings; **only its argon2 hash is stored**; raw key kept on paper.
- LOCKDOWN button (permission `system_lockdown`) → `system_state = LOCKED` in DB.
- Middleware before auth/routing: when LOCKED, empty `503`, no body — browser shows "connection failed." **No exceptions, admin included.**
- Sole exception: secret wake URL (slug from env var). Bare page, key input, argon2 verify → `ACTIVE`.
- Wake endpoint rate-limited by IP, all attempts logged.
- Console fallback SQL documented in the runbook.
- DB + web server stay up during lockdown; background jobs and provider calls pause.

---

## 8. Non-functional requirements

- **Security:** server-side permission checks everywhere; bcrypt/argon2 for all secrets; provider keys never reach the browser; HTTPS only.
- **Audit:** log login, lead create, every transfer request, every routing decision, close, permission change, lockdown/wake.
- **Performance:** search results < 3s (cache hit < 300ms); routing queue loads < 1s at 1,000 pending rows.
- **Cost control:** cache-first on every provider call; daily spend cap per provider with alert.
- **Compliance:** provider data used for sales lead-gen only — never expose features for credit/employment/insurance/tenant screening decisions (FCRA/DPPA/GLBA restricted).

---

## 9. Open items to confirm before coding

1. Stack confirmation (NestJS default; Django acceptable).
2. First data provider + credentials (else start on mock).
3. Should a Closer be able to send a lead **directly** back to a specific person, or must every send-back pass through the Admin queue? (Spec assumes: through the queue.)
4. Notifications v1: in-app only, or email/WhatsApp too?
5. Expected daily lead volume — sizes the routing queue UX and infrastructure.
