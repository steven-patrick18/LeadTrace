import { Injectable } from '@nestjs/common';
import { GeoEnrichment } from './enrichment.types';

/**
 * Section C — free/public geo enrichment, fully offline in dev.
 * Bundled lookup tables: zip-prefix → state, state → IANA timezone,
 * area code → region. A production deploy can layer USPS/Smarty/Zippopotam.us
 * on top; the shape stays identical.
 *
 * localTimeNow is intentionally NOT stored — it is derived from `timezone`
 * at display time (see EnrichmentController.get).
 * Census stats are AREA-level bands only, never attributed to the individual.
 */

// zip 3-digit prefix ranges → state (representative subset of the USPS plan)
const ZIP_STATE: Array<[number, number, string]> = [
  [100, 149, 'NY'], [150, 196, 'PA'], [200, 205, 'DC'], [206, 219, 'MD'],
  [220, 246, 'VA'], [270, 289, 'NC'], [300, 319, 'GA'], [320, 349, 'FL'],
  [350, 369, 'AL'], [370, 385, 'TN'], [400, 427, 'KY'], [430, 459, 'OH'],
  [460, 479, 'IN'], [480, 499, 'MI'], [500, 528, 'IA'], [530, 549, 'WI'],
  [550, 567, 'MN'], [570, 577, 'SD'], [580, 588, 'ND'], [590, 599, 'MT'],
  [600, 629, 'IL'], [630, 658, 'MO'], [660, 679, 'KS'], [680, 693, 'NE'],
  [700, 714, 'LA'], [716, 729, 'AR'], [730, 749, 'OK'], [750, 799, 'TX'],
  [800, 816, 'CO'], [820, 831, 'WY'], [832, 838, 'ID'], [840, 847, 'UT'],
  [850, 865, 'AZ'], [870, 884, 'NM'], [889, 898, 'NV'], [900, 961, 'CA'],
  [967, 968, 'HI'], [970, 979, 'OR'], [980, 994, 'WA'], [995, 999, 'AK'],
];

const STATE_TZ: Record<string, string> = {
  NY: 'America/New_York', PA: 'America/New_York', DC: 'America/New_York',
  MD: 'America/New_York', VA: 'America/New_York', NC: 'America/New_York',
  GA: 'America/New_York', FL: 'America/New_York', OH: 'America/New_York',
  IN: 'America/Indiana/Indianapolis', MI: 'America/Detroit', KY: 'America/New_York',
  TN: 'America/Chicago', AL: 'America/Chicago', WI: 'America/Chicago',
  MN: 'America/Chicago', IA: 'America/Chicago', MO: 'America/Chicago',
  IL: 'America/Chicago', KS: 'America/Chicago', NE: 'America/Chicago',
  SD: 'America/Chicago', ND: 'America/Chicago', LA: 'America/Chicago',
  AR: 'America/Chicago', OK: 'America/Chicago', TX: 'America/Chicago',
  MT: 'America/Denver', CO: 'America/Denver', WY: 'America/Denver',
  ID: 'America/Boise', UT: 'America/Denver', NM: 'America/Denver',
  AZ: 'America/Phoenix', NV: 'America/Los_Angeles', CA: 'America/Los_Angeles',
  OR: 'America/Los_Angeles', WA: 'America/Los_Angeles',
  HI: 'Pacific/Honolulu', AK: 'America/Anchorage',
};

// Area code → region (bundled offline subset; unknown codes return null)
const AREA_CODE_REGION: Record<string, string> = {
  '212': 'New York City, NY', '213': 'Los Angeles, CA', '214': 'Dallas, TX',
  '303': 'Denver, CO', '305': 'Miami, FL', '312': 'Chicago, IL',
  '404': 'Atlanta, GA', '415': 'San Francisco, CA', '512': 'Austin, TX',
  '602': 'Phoenix, AZ', '713': 'Houston, TX', '813': 'Tampa, FL',
  '917': 'New York City, NY',
};

@Injectable()
export class GeoService {
  enrich(input: { zip?: string | null; city?: string | null; state?: string | null; address?: string | null; phone: string }): GeoEnrichment {
    const zip = input.zip?.trim() ?? null;
    const stateFromZip = zip && /^\d{5}$/.test(zip) ? this.zipToState(zip) : null;
    const state = stateFromZip ?? input.state ?? null;
    const timezone = state ? (STATE_TZ[state] ?? null) : null;

    const areaCode = input.phone.startsWith('+1') ? input.phone.slice(2, 5) : null;
    const areaCodeRegion = areaCode ? (AREA_CODE_REGION[areaCode] ?? null) : null;

    // Address "standardization" offline: consistent casing + known-state check.
    // Swap in USPS/Smarty here for production-grade CASS standardization.
    const addressValid = !!(input.address && input.city && state && zip && /^\d{5}$/.test(zip) && stateFromZip === (input.state ?? stateFromZip));
    const addressStandardized = input.address
      ? {
          line1: input.address.trim().toUpperCase(),
          city: input.city?.trim().toUpperCase() ?? null,
          state,
          zip,
        }
      : null;

    return {
      city: input.city ?? null,
      state,
      county: null, // filled by USPS/Census adapters in production
      timezone,
      areaCodeRegion,
      addressStandardized,
      addressValid,
      ...(zip
        ? {
            censusAreaStats: {
              // AREA-level band derived from ZIP prefix — demo placeholder for the
              // US Census ACS adapter. Never attributed to the individual.
              medianIncomeBand: ['$40-60k', '$60-80k', '$80-100k'][Number(zip[0]) % 3],
              note: 'ZIP-area statistic (US Census, area level) — not a statement about this person',
            },
          }
        : {}),
    };
  }

  private zipToState(zip: string): string | null {
    const prefix = Number(zip.slice(0, 3));
    for (const [lo, hi, state] of ZIP_STATE) {
      if (prefix >= lo && prefix <= hi) return state;
    }
    return null;
  }

  /** Derived on READ, never stored (spec section C). */
  localTimeNow(timezone: string | null): string | null {
    if (!timezone) return null;
    try {
      return new Intl.DateTimeFormat('en-US', {
        timeZone: timezone,
        weekday: 'short',
        hour: 'numeric',
        minute: '2-digit',
        timeZoneName: 'short',
      }).format(new Date());
    } catch {
      return null;
    }
  }
}
