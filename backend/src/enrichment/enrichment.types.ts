/**
 * Enrichment data shapes (spec sections A, C, D, E).
 *
 * HARD SCOPE RULE (enforced in code and by static test):
 * - socialUrls are provider-returned URL STRINGS only. They are stored and
 *   displayed as links — NEVER fetched, scraped, or resolved by this system.
 * - No photo fetching, no face matching, no biometric data of any kind.
 * - Census/demographic data is AREA-level only, never attributed to the person.
 */

// ── Section A: licensed provider data ────────────────────────
export interface EnrichedAddress {
  line1: string;
  city: string;
  state: string;
  zip: string;
  county?: string;
  type: 'current' | 'past';
  since?: string;
}

export interface EnrichedPhone {
  number: string; // E.164
  lineType: 'mobile' | 'landline' | 'voip' | 'unknown';
  carrier?: string;
  active: boolean;
  spamRisk: 'low' | 'med' | 'high';
  isPrimary: boolean;
  /** How many active providers independently reported this phone (cross-verification). */
  verifiedBy?: number;
}

/**
 * Carrier-authoritative confirmation that a name/address BELONGS to the phone.
 * This is a VERIFICATION result (e.g. Twilio Lookup Identity Match), not a data
 * source — it returns match levels for data we already hold, never new PII.
 * SSN / national ID is never submitted (see enrichment.service).
 */
export type IdentityMatchLevel = 'exact_match' | 'high_partial_match' | 'partial_match' | 'no_match' | 'no_data_available';
export interface IdentityVerification {
  summaryScore: number; // 0..100 (carrier-scored)
  fields: Partial<Record<'firstName' | 'lastName' | 'addressLines' | 'city' | 'state' | 'postalCode' | 'dateOfBirth', IdentityMatchLevel>>;
  verifiedName: string;
  verifiedAddress: string | null;
  source: string; // provider code that performed the match
  checkedAt: string; // ISO
}

/** One provider's own result + score, shown alongside the merged best record. */
export interface ProviderContribution {
  code: string;
  confidence: number; // 0..100, this provider's own confidence
  name: string | null; // best name/alias this provider returned, if any
  topAddress: string | null; // this provider's current address, if any
  counts: { phones: number; addresses: number; emails: number; relatives: number };
}

export interface PersonEnrichment {
  aliases: string[];
  addresses: EnrichedAddress[];
  phones: EnrichedPhone[];
  emails: string[];
  ageRange: string | null;
  relatives: Array<{ name: string; relation?: string }>;
  associates: Array<{ name: string }>;
  property: { ownership: 'own' | 'rent' | 'unknown'; estValue?: number; type?: string };
  socialUrls: string[]; // URL strings ONLY — never fetched (see scope rule above)
  providerConfidence: number; // 0..1
  sourceProvider: string;
  /** When merged from several active providers: which ones contributed. */
  sources?: string[];
  /** Carrier-authoritative match of the merged name+address to the phone. */
  identityVerification?: IdentityVerification | null;
  /** Per-provider breakdown — what EACH active provider returned + its score. */
  contributors?: ProviderContribution[];
  /**
   * 0..100 cross-provider accuracy for the merged record: rises with the number
   * of providers, their individual confidence, and how much they AGREE
   * (fields confirmed by 2+ sources). Present only on multi-provider merges.
   */
  accuracyScore?: number;
}

// ── Section C: free / public geo data ────────────────────────
export interface GeoEnrichment {
  city: string | null;
  state: string | null;
  county: string | null;
  timezone: string | null; // IANA — localTimeNow derived from this on READ, never stored
  areaCodeRegion: string | null;
  addressStandardized: { line1: string | null; city: string | null; state: string | null; zip: string | null } | null;
  addressValid: boolean;
  censusAreaStats?: { medianIncomeBand: string; note: string }; // AREA level only
}

// ── Section D: compliance ─────────────────────────────────────
export type DncStatus = 'on_list' | 'clear' | 'unknown';

export interface ComplianceData {
  nationalDncStatus: DncStatus;
  stateDncStatus: DncStatus;
  internalDncStatus: 'on_list' | 'clear'; // in-house table — authoritative, always known
  litigatorFlag: boolean;
  priorConsent: { hasConsent: boolean; source?: string; timestamp?: string };
  callable: boolean; // computed gate — false blocks dialing in UI + server
}

// ── Section E: computed in-house ─────────────────────────────
export interface Intelligence {
  dataCompletenessPct: number;
  leadScore: number; // 0..100
  conversionProbability: number; // 0..1
  conversionProbabilityMethod: 'heuristic' | 'model'; // never a black box without fallback
  bestTimeToCall: string;
  contactHistory: Array<{ at: string; agent: string; outcome: string }>;
  duplicateFlag: boolean;
  routingHint?: { userId: number; name: string; reason: string };
  scoreBreakdown: Array<{ key: string; points: number; reason: string }>; // reproducibility
}

// ── Provider plug points ─────────────────────────────────────
export interface EnrichmentDataProvider {
  readonly code: string;
  /** Cost in cents per successful live (non-cached) lookup. */
  enrichPerson(input: { phone: string; firstName: string; lastName: string; zip?: string | null }): Promise<PersonEnrichment>;
}

export interface DncScrubProvider {
  readonly code: string;
  scrub(phone: string): Promise<{
    nationalDncStatus: DncStatus;
    stateDncStatus: DncStatus;
    litigatorFlag: boolean;
  }>;
}
