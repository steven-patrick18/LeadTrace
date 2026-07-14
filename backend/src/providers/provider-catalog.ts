/**
 * The provider CATALOG — the single source of truth for which data providers
 * exist, their onboarding docs, and their default state.
 *
 * Shared by the seed (prisma/seed.ts) AND the startup sync
 * (provider-catalog.service.ts) so a plain `git pull + restart` (the System
 * page "Update from Git" button) always refreshes the catalog on production —
 * new providers appear without ever having to re-run the seed.
 *
 * Admin-managed state (isActive, credentials, costs, limits) is NEVER touched by
 * the sync; only the catalog copy (description, URLs, howToGet) is refreshed.
 */
export interface CatalogProvider {
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

export const PROVIDER_CATALOG: CatalogProvider[] = [
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
    code: 'SEARCHBUG',
    displayName: 'SearchBug (People Search)',
    description:
      'Broad-coverage reverse phone → identity: name, current + past addresses, alternate phones, emails, age and relatives. Easy self-serve signup with a prepaid balance; also offers caller-ID, DNC scrub and reassigned-number checks.',
    websiteUrl: 'https://www.searchbug.com',
    signupUrl: 'https://www.searchbug.com/account/signup.aspx',
    docsUrl: 'https://www.searchbug.com/info/api/people-search-api/',
    howToGet:
      'Adapter IMPLEMENTED (People Search API, reverse phone). Uses GET data.searchbug.com/api/search.aspx with TYPE_API=api_ppl&F=<phone>&FORMAT=JSON.\n1. Create an account at searchbug.com and load a prepaid balance (a free sandbox test account is available).\n2. In your dashboard open API access and copy your API Key (and Account CO_CODE if shown).\n3. Paste the API Key as API Key below. If your account uses CO_CODE auth, paste the CO_CODE as API Secret (otherwise leave it blank — the Bearer key is enough).\n4. Record the permitted-use attestation (sales & marketing / lead generation, NOT FCRA/DPPA) and Activate.\nNote: the SSN/skip-trace (Professional Trace) products need a separate Restricted-Access approval from SearchBug and are NOT used by this adapter.',
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
      'Instant pay-as-you-go account. Returns caller-ID name (a reverse-phone identity), line type and carrier — PLUS Identity Match, a carrier-authoritative check that a name+address belongs to the phone (0–100 accuracy score). One of the easiest APIs to get.',
    websiteUrl: 'https://www.twilio.com/lookup',
    signupUrl: 'https://www.twilio.com/try-twilio',
    docsUrl: 'https://www.twilio.com/docs/lookup/v2-api/identity-match',
    howToGet:
      'Adapter IMPLEMENTED (caller-ID + line type + Identity Match). Easiest instant signup.\n1. Create a free Twilio account at twilio.com/try-twilio (instant, small trial credit).\n2. From the Console dashboard copy your Account SID and Auth Token.\n3. Save the Account SID as API key and the Auth Token as API secret below.\n4. Record the attestation and Activate. caller_name (CNAM) ≈ $0.01, line type ≈ $0.008, Identity Match ≈ $0.10–$1.20/query (US needs no registration).\nOn Enrich, if this provider is active LeadTrace automatically verifies the lead name+address against the phone via Identity Match. Note: SSN/national ID is never submitted.',
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
