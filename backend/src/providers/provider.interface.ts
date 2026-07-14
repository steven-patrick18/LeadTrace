/**
 * Provider abstraction (spec Phase 2). Every licensed data provider —
 * mock today; Endato/Enformion, Trestle/Whitepages Pro, IDI, etc. tomorrow —
 * implements this one interface and returns the ONE normalized shape below.
 * Swapping providers is a DB config change (provider_settings.is_active),
 * never a code change at call sites.
 */

export interface PersonSearchQuery {
  phone?: string; // E.164 after normalization
  firstName?: string;
  lastName?: string;
  zip?: string;
}

export interface PersonMatch {
  firstName: string;
  lastName: string;
  phones: Array<{ number: string; lineType: 'mobile' | 'landline' | 'voip' | 'unknown'; isPrimary: boolean }>;
  address: string | null;
  city: string | null;
  state: string | null;
  zip: string | null;
  ageRange: string | null;
  relatives: string[];
  /**
   * 0–100. How well this record matches the query. Computed from field-level
   * agreement (phone exact = strongest signal, then name+zip). Surfaced in the
   * UI so operators can judge data quality before converting to a lead.
   */
  confidence: number;
  sourceProvider: string;
}

export interface PersonDataProvider {
  /** Stable code matching provider_settings.code (e.g. MOCK, ENDATO). */
  readonly code: string;
  searchPerson(query: PersonSearchQuery): Promise<PersonMatch[]>;
}
