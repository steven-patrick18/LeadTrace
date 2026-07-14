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
  // adapter is implemented.
  interface SeedProvider {
    code: string;
    displayName: string;
    description: string;
    isActive?: boolean;
    websiteUrl?: string;
    signupUrl?: string;
    docsUrl?: string;
    howToGet: string;
    permittedUseAttestation?: string;
  }
  const PROVIDERS: SeedProvider[] = [
    {
      code: 'MOCK',
      displayName: 'Mock Provider (dev)',
      description:
        'Deterministic synthetic data for development and training. Free, instant, and safe — every phone number is in the reserved fictional 555-01XX range.',
      isActive: true,
      howToGet: 'Nothing to set up — built in. Use it for development, demos, and operator training.',
      permittedUseAttestation:
        'Development mock data. Real providers require a recorded permitted-use attestation: sales lead-generation only — never credit, employment, insurance, or tenant-screening decisions (FCRA/DPPA/GLBA).',
    },
    {
      code: 'LEADTRACE_ENGINE',
      displayName: 'LeadTrace Engine (free tier)',
      description:
        'Our own self-hosted engine — $0, no third-party account. Offline phone intelligence (valid/invalid, line type, region via libphonenumber), ZIP/area-code geo, and cross-reference against your own existing leads and enrichments. No scraping, no paid data. Use it as your always-on free baseline; layer paid providers on top when you need deeper coverage.',
      isActive: false,
      howToGet:
        'Nothing to set up — built into LeadTrace. Click Activate to make it the live provider for search and enrichment. It never leaves your server and never buys or scrapes data, so there is no cost and no credential.\n\nWhat it returns:\n• Phone: validity, line type (mobile/landline/voip), country — kills wasted dials.\n• Geo: city/state/timezone from ZIP, area-code region.\n• First-party: aliases, prior addresses and extra phones already in your database.\n\nWhat it will NOT do (by policy): scrape social/web content, fetch photos, or build biometric data. For deeper third-party coverage, add a licensed provider (Endato, Trestle, IDI, BatchData, Melissa) and activate it.',
      permittedUseAttestation:
        'LeadTrace Engine uses only offline reference data and your own first-party records for sales lead-generation. It performs no third-party data scraping and never processes credit, employment, insurance, or tenant-screening decisions (FCRA/DPPA/GLBA).',
    },
    {
      code: 'ENDATO',
      displayName: 'Endato (Enformion)',
      description:
        'Person search, contact enrichment and reverse phone APIs by Enformion. Popular with sales/skip-tracing shops; simple REST API with per-search pricing.',
      websiteUrl: 'https://endato.com',
      signupUrl: 'https://endato.com/contact-sales/',
      docsUrl: 'https://docs.endato.com',
      howToGet:
        '1. Go to endato.com and request API access (self-serve trial or contact sales).\n2. Complete their permitted-use questionnaire — answer "sales & marketing / lead generation" (NOT FCRA uses).\n3. In the Endato dashboard, create an API profile: you receive an AP Name and AP Password.\n4. Paste the AP Name as API Key and AP Password as API Secret below, then Save credentials.\n5. Record the permitted-use attestation and set your negotiated cost per search.',
    },
    {
      code: 'TRESTLE',
      displayName: 'Trestle (Whitepages Pro)',
      description:
        'Reverse Phone, Find Person and Real Contact APIs — the former Whitepages Pro data. Strong phone intelligence: line type, carrier, activity score.',
      websiteUrl: 'https://trestleiq.com',
      signupUrl: 'https://trestleiq.com/free-trial/',
      docsUrl: 'https://trestle-api.redoc.ly',
      howToGet:
        'Adapter IMPLEMENTED. Uses Phone Validation ($0.015) + Real Contact ($0.03) — the endpoints available on self-serve — for phone quality (line type, carrier, activity, contact grade, name match).\n1. Sign up at trestleiq.com and add wallet funds (pay-as-you-go).\n2. Copy your API key from the portal (the "Current Key") and Save it below.\n3. Record the attestation, then Activate.\nNOTE: full identity (owner name + addresses) needs Trestle\'s Reverse Phone API, which is "Request Access" on self-serve — enable it in the portal to unlock richer data here.',
    },
    {
      code: 'IDI',
      displayName: 'idiCORE (IDI Data)',
      description:
        'Enterprise-grade investigative data (idiCORE). Deepest coverage — addresses, relatives, associates — but requires business vetting and a signed use agreement.',
      websiteUrl: 'https://www.ididata.com',
      signupUrl: 'https://www.ididata.com/contact/',
      docsUrl: 'https://www.ididata.com/idicore/',
      howToGet:
        '1. Contact IDI sales at ididata.com — enterprise onboarding only.\n2. Pass their credentialing: business verification, site visit/desk audit, signed DPPA/GLBA permitted-use agreement (choose non-FCRA sales/marketing use).\n3. Receive API credentials from your account manager.\n4. Save them below and record the attestation exactly as signed.',
    },
    {
      code: 'BATCHDATA',
      displayName: 'BatchData (BatchSkipTracing)',
      description:
        'Skip-tracing and property-owner contact data, popular in real-estate calling operations. Per-hit pricing and bulk endpoints.',
      websiteUrl: 'https://batchdata.com',
      signupUrl: 'https://batchdata.com/sign-up/',
      docsUrl: 'https://developer.batchdata.com',
      howToGet:
        '1. Create an account at batchdata.com and load account balance (skip-trace is pay-per-hit).\n2. In the developer portal, generate an API token (Bearer).\n3. Paste the token as API Key below and Save credentials.\n4. Record the attestation and per-hit cost.\n5. The BatchData adapter is IMPLEMENTED — once your account has balance, click Activate and it serves live skip-trace search + enrichment. Without balance, live calls return "Insufficient balance".',
    },
    {
      code: 'MELISSA',
      displayName: 'Melissa Global Phone',
      description:
        'Reverse phone lookup (Global Phone API): caller-ID name, carrier, line type, and the number\'s city/county/state/ZIP/timezone. A genuine phone → identity source.',
      websiteUrl: 'https://www.melissa.com',
      signupUrl: 'https://www.melissa.com/user/signup',
      docsUrl: 'https://docs.melissa.com',
      howToGet:
        'Adapter IMPLEMENTED — uses the Global Phone API (reverse phone → caller-ID name + carrier + line type + geo).\n1. Sign up at melissa.com and copy your Cloud License Key (~24 chars).\n2. Enable the GLOBAL PHONE product on that license and add credits (a valid key with no Global Phone credits returns GE08).\n3. Paste the key below, record the attestation, then Activate.\nOnce enabled, searching a phone returns the caller-ID owner + location automatically.',
    },
    // ── Easy-signup providers (instant API keys, no sales call) ──
    {
      code: 'TWILIO_LOOKUP',
      displayName: 'Twilio Lookup',
      description:
        'Instant pay-as-you-go account. Returns caller-ID name (a reverse-phone identity), line type and carrier. One of the easiest APIs to get.',
      websiteUrl: 'https://www.twilio.com/lookup',
      signupUrl: 'https://www.twilio.com/try-twilio',
      docsUrl: 'https://www.twilio.com/docs/lookup/v2-api',
      howToGet:
        'Adapter IMPLEMENTED. Easiest instant signup.\n1. Create a free Twilio account at twilio.com/try-twilio (instant, small trial credit).\n2. From the Console dashboard copy your Account SID and Auth Token.\n3. Save the Account SID as API key and the Auth Token as API secret below.\n4. Record the attestation and Activate. caller_name (CNAM) ≈ $0.01/lookup, line type ≈ $0.008.',
    },
    {
      code: 'IPQS',
      displayName: 'IPQualityScore (Phone)',
      description:
        'Phone validation with a fraud/spam score and line intelligence. FREE 5,000 lookups/month, instant key — great for the callable gate and spam-risk.',
      websiteUrl: 'https://www.ipqualityscore.com',
      signupUrl: 'https://www.ipqualityscore.com/create-account',
      docsUrl: 'https://www.ipqualityscore.com/documentation/phone-number-validation-api/overview',
      howToGet:
        'Adapter IMPLEMENTED. Free instant key.\n1. Create a free account at ipqualityscore.com (5,000 lookups/month free).\n2. Copy your API key from the dashboard.\n3. Paste it as API key below, record the attestation, and Activate.\nReturns validity, active status, line type, carrier and a fraud/spam score.',
    },
    {
      code: 'NUMVERIFY',
      displayName: 'NumVerify (apilayer)',
      description:
        'The simplest phone-validation API: validity, line type, carrier, country and location. FREE 100 lookups/month, instant key.',
      websiteUrl: 'https://numverify.com',
      signupUrl: 'https://numverify.com/product',
      docsUrl: 'https://numverify.com/documentation',
      howToGet:
        'Adapter IMPLEMENTED. Free instant key.\n1. Sign up at numverify.com (free tier: 100 lookups/month).\n2. Copy your API Access Key.\n3. Paste it as API key below, record the attestation, and Activate.',
    },
    // ── Catalog only (easy signups; adapters can be added on request) ──
    {
      code: 'VERIPHONE',
      displayName: 'Veriphone',
      description:
        'Simple global phone validation (valid, type, carrier, country). Free tier with an instant key.',
      websiteUrl: 'https://veriphone.io',
      signupUrl: 'https://veriphone.io/',
      docsUrl: 'https://veriphone.io/docs',
      howToGet:
        'Easy instant key at veriphone.io (free tier). Paste it below and Save. Ask your developer to enable the Veriphone adapter, then Activate.',
    },
    {
      code: 'ABSTRACT_PHONE',
      displayName: 'Abstract Phone Validation',
      description:
        'AbstractAPI phone validation: valid, line type, carrier, location. Free tier, instant key, very simple REST.',
      websiteUrl: 'https://www.abstractapi.com/api/phone-validation-api',
      signupUrl: 'https://www.abstractapi.com/api/phone-validation-api',
      docsUrl: 'https://docs.abstractapi.com/phone-validation',
      howToGet:
        'Easy instant key at abstractapi.com (free tier). Paste it below and Save. Ask your developer to enable the Abstract adapter, then Activate.',
    },
    {
      code: 'TELNYX',
      displayName: 'Telnyx Number Lookup',
      description:
        'Telnyx Number Lookup: carrier, line type and portability. Instant self-serve account, pay-as-you-go.',
      websiteUrl: 'https://telnyx.com/products/number-lookup',
      signupUrl: 'https://telnyx.com/sign-up',
      docsUrl: 'https://developers.telnyx.com/docs/api/v2/number-lookup',
      howToGet:
        'Create a Telnyx account (instant), generate an API key. Paste it below and Save. Ask your developer to enable the Telnyx adapter, then Activate.',
    },
  ];
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
