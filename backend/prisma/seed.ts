/**
 * Seed: 5 roles, the default permission matrix from spec §3,
 * system_state row, app settings, the mock provider, and demo users.
 * The matrix here is the SEED ONLY — after first run the Admin owns it via the UI.
 */
import { PrismaClient, PermissionScope } from '@prisma/client';
import * as argon2 from 'argon2';

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
  };
  for (const [key, value] of Object.entries(settings)) {
    await prisma.appSetting.upsert({ where: { key }, update: {}, create: { key, value } });
  }

  // Mock provider — active by default so dev costs $0 (spec Phase 2)
  await prisma.providerSetting.upsert({
    where: { code: 'MOCK' },
    update: {},
    create: {
      code: 'MOCK',
      displayName: 'Mock Provider (dev)',
      isActive: true,
      costPerSearchCents: 0,
      dailySpendCapCents: 0,
      cacheTtlHours: 720,
      permittedUseAttestation:
        'Development mock data. Real providers require a recorded permitted-use attestation: sales lead-generation only — never credit, employment, insurance, or tenant-screening decisions (FCRA/DPPA/GLBA).',
    },
  });

  // Demo users (dev only — change passwords in production)
  const demoPassword = process.env.SEED_USER_PASSWORD || 'LeadTrace!Dev1';
  const hash = await argon2.hash(demoPassword);
  const demoUsers = [
    { name: 'Alice Admin', email: 'admin@leadtrace.local', roleCode: 'ADMIN' },
    { name: 'Mark Manager', email: 'manager@leadtrace.local', roleCode: 'MANAGER' },
    { name: 'Amy Agent', email: 'agent@leadtrace.local', roleCode: 'AGENT' },
    { name: 'Andy Agent', email: 'agent2@leadtrace.local', roleCode: 'AGENT' },
    { name: 'Sam Senior', email: 'sragent@leadtrace.local', roleCode: 'SR_AGENT' },
    { name: 'Sara Senior', email: 'sragent2@leadtrace.local', roleCode: 'SR_AGENT' },
    { name: 'Carl Closer', email: 'closer@leadtrace.local', roleCode: 'CLOSER' },
  ];
  for (const u of demoUsers) {
    await prisma.user.upsert({
      where: { email: u.email },
      update: {},
      create: { name: u.name, email: u.email, passwordHash: hash, roleId: roleIds[u.roleCode] },
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
