/**
 * Seed: 5 roles, the default permission matrix from spec §3,
 * system_state row, app settings, the mock provider, and demo users.
 * The matrix here is the SEED ONLY — after first run the Admin owns it via the UI.
 */
import { PrismaClient, PermissionScope } from '@prisma/client';
import * as argon2 from 'argon2';
import { PROVIDER_CATALOG } from '../src/providers/provider-catalog';

const prisma = new PrismaClient();

type Cell = boolean | 'OWN' | 'ASSIGNED' | 'ALL' | 'VIEW';

const ROLES = [
  { roleCode: 'AGENT', displayName: 'Agent', tier: 1 },
  { roleCode: 'SR_AGENT', displayName: 'Sr Agent', tier: 2 },
  { roleCode: 'CLOSER', displayName: 'Closer', tier: 3 },
  { roleCode: 'MANAGER', displayName: 'Manager', tier: null },
  { roleCode: 'ADMIN', displayName: 'Admin', tier: null },
];

// permission_key → [AGENT, SR_AGENT, CLOSER, MANAGER, ADMIN]  (spec §3 default matrix)
const MATRIX: Record<string, [Cell, Cell, Cell, Cell, Cell]> = {
  search_providers:   [true,  true,  false, true,  true],
  create_lead:        [true,  true,  false, true,  true],
  view_own_leads:     [true,  true,  true,  true,  true],
  view_all_leads:     [false, false, false, true,  true],
  edit_lead:          ['OWN', 'ASSIGNED', 'ASSIGNED', 'ALL', 'ALL'],
  log_activity:       [true,  true,  true,  true,  true],
  request_transfer:   [true,  true,  false, true,  true],
  route_leads:        [false, false, false, false, true],
  close_deal:         [false, false, true,  true,  true],
  send_back:          [false, false, true,  true,  true],
  view_reports_team:  [false, false, false, true,  true],
  view_reports_own:   [true,  true,  true,  true,  true],
  view_api_costs:     [false, false, false, true,  true],
  export_data:        [false, false, false, true,  true],
  manage_users:       [false, false, false, 'VIEW', true],
  manage_permissions: [false, false, false, false, true],
  manage_providers:   [false, false, false, false, true],
  system_lockdown:    [false, false, false, false, true],
  // Lead enrichment module
  enrich_lead:          [true,  true,  true,  true,  true],
  view_enrichment:      [true,  true,  true,  true,  true],
  edit_score_weights:   [false, false, false, false, true],
  manage_dnc_optout:    [false, false, false, true,  true],
  view_enrichment_cost: [false, false, false, true,  true],
  // Custom fields, comments, per-lead access control
  manage_custom_fields: [false, false, false, false, true],
  comment_lead:         [true,  true,  true,  true,  true], // + server-side participant rule
  manage_lead_access:   [false, false, false, false, true],
  // Desk / batch-id sessions: manager sees the floor, admin manages it
  manage_desks:         [false, false, false, 'VIEW', true],
};

function cellToPermission(cell: Cell): { allowed: boolean; scope: PermissionScope } {
  if (cell === true) return { allowed: true, scope: PermissionScope.ALL };
  if (cell === false) return { allowed: false, scope: PermissionScope.ALL };
  return { allowed: true, scope: PermissionScope[cell] };
}

async function main() {
  // Roles
  const roleIds: Record<string, number> = {};
  for (const r of ROLES) {
    const role = await prisma.role.upsert({
      where: { roleCode: r.roleCode },
      update: {},
      create: r,
    });
    roleIds[r.roleCode] = role.id;
  }

  // Permission matrix
  const order = ['AGENT', 'SR_AGENT', 'CLOSER', 'MANAGER', 'ADMIN'];
  for (const [key, cells] of Object.entries(MATRIX)) {
    for (let i = 0; i < order.length; i++) {
      const { allowed, scope } = cellToPermission(cells[i]);
      await prisma.permission.upsert({
        where: { roleId_permissionKey: { roleId: roleIds[order[i]], permissionKey: key } },
        update: {},
        create: { roleId: roleIds[order[i]], permissionKey: key, allowed, scope },
      });
    }
  }

  // System state singleton
  await prisma.systemState.upsert({
    where: { id: 1 },
    update: {},
    create: { id: 1, status: 'ACTIVE' },
  });

  // App settings
  const settings: Record<string, string> = {
    routing_aging_threshold_minutes: '60',
    search_cache_ttl_hours: '720',
    enrichment_daily_cap_cents: '2500', // $25/day — paid enrichment pauses on breach
    enrichment_cache_ttl_hours: '720', // 30 days — re-enrich within TTL is free
    batch_session_minutes: '30', // quick-session duration; auto-logout after
    require_desk_for_calls: 'false', // optional discipline: calls need a desk clock-in
  };
  for (const [key, value] of Object.entries(settings)) {
    await prisma.appSetting.upsert({ where: { key }, update: {}, create: { key, value } });
  }

  // Lead-score weights (spec section E) — Admin-editable at runtime
  const weights: Record<string, number> = {
    phone_active_mobile: 30,
    has_valid_email: 10,
    property_owner: 15,
    address_validated: 10,
    callable: 20,
    data_completeness_max: 15,
    not_callable_score_cap: 25, // hard cap on the total score when callable=false
  };
  for (const [key, weight] of Object.entries(weights)) {
    await prisma.scoreWeight.upsert({ where: { key }, update: {}, create: { key, weight } });
  }

  // Provider catalog. MOCK ships active so dev costs $0 (spec Phase 2); real
  // providers ship inactive with onboarding instructions — the Admin saves
  // credentials + attestation on the Providers page, then activates once the
  // adapter is implemented. The catalog itself lives in
  // src/providers/provider-catalog.ts so the app can also sync it on every boot
  // (the "Update from Git" button runs migrations but not this seed).
  const PROVIDERS = PROVIDER_CATALOG;
  for (const p of PROVIDERS) {
    const { code, isActive, ...fields } = p;
    await prisma.providerSetting.upsert({
      where: { code },
      // keep admin-managed state (isActive, credentials, costs) on re-seed;
      // refresh only the catalog copy so docs/instructions stay current
      update: {
        description: fields.description,
        websiteUrl: fields.websiteUrl,
        signupUrl: fields.signupUrl,
        docsUrl: fields.docsUrl,
        howToGet: fields.howToGet,
      },
      create: { code, isActive: isActive ?? false, ...fields },
    });
  }

  // Demo users (dev only — change passwords in production)
  const demoPassword = process.env.SEED_USER_PASSWORD || 'LeadTrace!Dev1';
  const hash = await argon2.hash(demoPassword);
  const demoUsers = [
    { name: 'Alice Admin', email: 'admin@leadtrace.local', roleCode: 'ADMIN', batchId: 'LT-ALICE' },
    { name: 'Mark Manager', email: 'manager@leadtrace.local', roleCode: 'MANAGER', batchId: 'LT-MARK' },
    { name: 'Amy Agent', email: 'agent@leadtrace.local', roleCode: 'AGENT', batchId: 'LT-AMY' },
    { name: 'Andy Agent', email: 'agent2@leadtrace.local', roleCode: 'AGENT', batchId: 'LT-ANDY' },
    { name: 'Sam Senior', email: 'sragent@leadtrace.local', roleCode: 'SR_AGENT', batchId: 'LT-SAM' },
    { name: 'Sara Senior', email: 'sragent2@leadtrace.local', roleCode: 'SR_AGENT', batchId: 'LT-SARA' },
    { name: 'Carl Closer', email: 'closer@leadtrace.local', roleCode: 'CLOSER', batchId: 'LT-CARL' },
  ];
  for (const u of demoUsers) {
    await prisma.user.upsert({
      where: { email: u.email },
      update: { batchId: u.batchId },
      create: { name: u.name, email: u.email, passwordHash: hash, roleId: roleIds[u.roleCode], batchId: u.batchId },
    });
  }

  // Default per-tier work-status lists — the Admin owns them after first run
  const TIER_STATUSES: Record<string, string[]> = {
    AGENT: ['Not contacted', 'No answer', 'Callback scheduled', 'Contacted — interested', 'Wrong number'],
    SR_AGENT: ['Warming up', 'Callback scheduled', 'Qualified — ready for closer', 'Not ready yet'],
    CLOSER: ['Final call scheduled', 'Negotiating', 'Contract sent', 'Post-sale processing'],
  };
  for (const [tier, labels] of Object.entries(TIER_STATUSES)) {
    for (let i = 0; i < labels.length; i++) {
      await prisma.tierStatus.upsert({
        where: { tier_label: { tier: tier as 'AGENT' | 'SR_AGENT' | 'CLOSER', label: labels[i] } },
        update: {},
        create: { tier: tier as 'AGENT' | 'SR_AGENT' | 'CLOSER', label: labels[i], sortOrder: i },
      });
    }
  }

  // Desks — the batch IDs people type when they sit down
  for (let i = 1; i <= 6; i++) {
    const code = `DESK-0${i}`;
    await prisma.desk.upsert({
      where: { code },
      update: {},
      create: { code, name: `Seat ${i}` },
    });
  }

  console.log('Seed complete. Demo users use password:', demoPassword);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
