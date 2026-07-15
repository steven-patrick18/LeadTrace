import { Injectable, Logger } from '@nestjs/common';
import { CountryCode, parsePhoneNumberFromString } from 'libphonenumber-js';
import { PrismaService } from '../common/prisma.service';
import { EnrichmentDataProvider, PersonEnrichment } from '../enrichment/enrichment.types';
import { PersonDataProvider, PersonMatch, PersonSearchQuery } from './provider.interface';

/**
 * SearchBug People Search API (reverse phone) — broad-coverage phone → identity:
 * name, current + past addresses, alternate phones, emails, DOB/age, relatives.
 * A genuine discovery source, easy self-serve signup with a prepaid balance.
 *
 * Endpoint: GET https://data.searchbug.com/api/search.aspx
 * Auth: `Authorization: Bearer <API key>` (recommended) or CO_CODE + PASS query.
 * Reverse phone: TYPE_API=api_ppl, F=<phone> (when F is set, other inputs are
 * ignored). FORMAT=JSON. Docs: https://www.searchbug.com/info/api/people-search-api/
 *
 * Response parsing is defensive across SearchBug's record/person nesting.
 * Account issues (bad key, no balance) throw so the merge skips this provider.
 */
@Injectable()
export class SearchBugProvider implements PersonDataProvider, EnrichmentDataProvider {
  readonly code = 'SEARCHBUG';
  private readonly logger = new Logger(SearchBugProvider.name);
  private readonly base = process.env.SEARCHBUG_BASE_URL || 'https://data.searchbug.com/api/search.aspx';
  private readonly region = (process.env.DEFAULT_PHONE_REGION || 'US') as CountryCode;

  constructor(private readonly prisma: PrismaService) {}

  private async creds(): Promise<{ apiKey: string; coCode: string }> {
    const p = await this.prisma.providerSetting.findUnique({ where: { code: this.code } });
    if (!p?.apiKey || !p?.apiSecret) {
      throw new Error('SearchBug needs BOTH the API Key (as API Key) and your CO_CODE account number (as API Secret)');
    }
    return { apiKey: p.apiKey, coCode: p.apiSecret };
  }

  /** Shared GET: CO_CODE+PASS query auth, browser UA, defensive error handling. */
  private async apiGet(params: Record<string, string>): Promise<any> {
    const { apiKey, coCode } = await this.creds();
    const qs = new URLSearchParams({ CO_CODE: coCode, PASS: apiKey, FORMAT: 'JSON', ...params });
    const headers: Record<string, string> = {
      Accept: 'application/json',
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
    };
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 25000);
    try {
      const res = await fetch(`${this.base}?${qs.toString()}`, { headers, signal: ctrl.signal });
      const text = await res.text();
      if (/<!DOCTYPE|<html|Cloudflare/i.test(text)) {
        throw new Error(
          `blocked at gateway (HTTP ${res.status}, Cloudflare). Ask SearchBug support to allowlist this server's IP for API access.`,
        );
      }
      let json: any = {};
      try {
        json = JSON.parse(text);
      } catch {
        throw new Error(`SearchBug returned non-JSON (HTTP ${res.status})`);
      }
      const errMsg = json?.Error || json?.error || json?.ERROR;
      if (errMsg) throw new Error(`SearchBug: ${errMsg}`);
      if (!res.ok) throw new Error(`SearchBug ${res.status}: ${res.statusText}`);
      return json;
    } finally {
      clearTimeout(timer);
    }
  }

  private async reversePhone(phone: string): Promise<any> {
    const digits = phone.replace(/\D/g, '').replace(/^1(?=\d{10}$)/, '');
    // Format verified live: TYPE=api_ppl selects reverse phone; F is the number.
    return this.apiGet({ TYPE: 'api_ppl', F: digits });
  }

  /**
   * REGULATED — SearchBug Background Report (TYPE=api_back, ~$15). Returns
   * criminal records, vehicles, and civil filings on top of the identity data.
   * This is an FCRA/DPPA-covered product; the CALLER (background.service) is
   * responsible for the permissible-purpose gate, attestation, and audit — this
   * method only performs the request the client's own account is entitled to.
   * Requires the client's SearchBug account to have Background Report enabled;
   * otherwise the API returns a "product not enabled" error we surface as-is.
   */
  async backgroundReport(input: { phone?: string; firstName?: string; lastName?: string; zip?: string | null }): Promise<any> {
    const params: Record<string, string> = { TYPE: 'api_back' };
    if (input.phone) params.F = input.phone.replace(/\D/g, '').replace(/^1(?=\d{10}$)/, '');
    if (input.firstName) params.FNAME = input.firstName;
    if (input.lastName) params.LNAME = input.lastName;
    if (input.zip) params.ZIP = input.zip;
    return this.apiGet(params);
  }

  private e164(v: unknown): string | null {
    if (typeof v !== 'string' && typeof v !== 'number') return null;
    const p = parsePhoneNumberFromString(String(v).trim(), this.region);
    return p && p.isValid() ? p.number : null;
  }

  private lineType(t: unknown): 'mobile' | 'landline' | 'voip' | 'unknown' {
    const s = String(t ?? '').toLowerCase();
    if (s.includes('wireless') || s.includes('mobile') || s.includes('cell')) return 'mobile';
    if (s.includes('landline') || s.includes('land') || s.includes('fixed')) return 'landline';
    if (s.includes('voip')) return 'voip';
    return 'unknown';
  }

  /**
   * SearchBug wraps XML-style: every list is {parent: {child: [...]}}. This
   * pulls the array whether it arrived as an array, a single object, or absent.
   * Field paths verified against the LIVE api_ppl response.
   */
  private list(node: any, key: string): any[] {
    const v = node?.[key];
    if (Array.isArray(v)) return v;
    if (v && typeof v === 'object') return [v];
    return [];
  }

  /** People live at people.person[] on the live api_ppl response. */
  private records(json: any): any[] {
    return this.list(json?.people, 'person');
  }

  /** Parse SearchBug's "MM/DD/YYYY" into epoch ms for recency sorting. */
  private ts(d: unknown): number {
    const m = String(d ?? '').match(/(\d{2})\/(\d{2})\/(\d{4})/);
    return m ? Date.UTC(Number(m[3]), Number(m[1]) - 1, Number(m[2])) : 0;
  }

  /** Best (most-recent) name from names.name[]; the rest become aliases. */
  private nameOf(person: any): { first: string; last: string; full: string } {
    const names = this.list(person?.names, 'name');
    if (!names.length) return { first: '', last: '', full: '' };
    const best = [...names].sort((a, b) => this.ts(b?.lastDate) - this.ts(a?.lastDate))[0];
    const first = String(best?.firstName ?? '').trim();
    const last = [best?.lastName, best?.nameSuffix].filter(Boolean).join(' ').trim();
    return { first, last, full: `${first} ${last}`.trim() };
  }

  private aliasesOf(person: any, primaryFull: string): string[] {
    const seen = new Set([primaryFull.toLowerCase()]);
    const out: string[] = [];
    for (const n of this.list(person?.names, 'name')) {
      const full = `${n?.firstName ?? ''} ${n?.lastName ?? ''}`.trim();
      if (full && !seen.has(full.toLowerCase())) {
        seen.add(full.toLowerCase());
        out.push(full);
      }
    }
    return out;
  }

  /**
   * Age band from DOBs.DOB[]. SearchBug returns several DOB candidates and lists
   * the best match FIRST — plus noise years. Use the first candidate that yields
   * a plausible adult age (never the earliest, which is usually the noise).
   */
  private ageFromDobs(person: any): string | null {
    const years = this.list(person?.DOBs, 'DOB')
      .map((d: any) => (this.ts(d) ? new Date(this.ts(d)).getUTCFullYear() : 0))
      .filter((y) => y >= 1925 && y <= 2008); // adult, non-noise
    if (!years.length) return null;
    const age = 2026 - years[0];
    return `${Math.max(18, age - 2)}-${age + 2}`;
  }

  /** addresses.address[] — most recent first (current), rest past. */
  private addressesOf(person: any): PersonEnrichment['addresses'] {
    return this.list(person?.addresses, 'address')
      .map((a: any) => ({
        line1: [a?.fullStreet, a?.apt ? `Apt ${a.apt}` : ''].filter(Boolean).join(' ').trim(),
        city: a?.city ?? '',
        state: a?.state ?? '',
        zip: [a?.zip, a?.plusFour].filter(Boolean).join('-') || a?.zip || '',
        county: a?.county ?? undefined,
        last: this.ts(a?.lastDate),
      }))
      .filter((a: any) => a.line1 || a.city)
      .sort((a: any, b: any) => b.last - a.last)
      .map(({ last, ...a }: any, i: number) => ({ ...a, type: (i === 0 ? 'current' : 'past') as 'current' | 'past' }));
  }

  /** phones.phone[] — line type + carrier per number. */
  private phonesOf(person: any, primary: string | null): PersonEnrichment['phones'] {
    const out: PersonEnrichment['phones'] = [];
    for (const ph of this.list(person?.phones, 'phone')) {
      const n = this.e164(ph?.phoneNumber);
      if (n && !out.some((x) => x.number === n)) {
        out.push({
          number: n,
          lineType: this.lineType(ph?.phoneType ?? ph?.carrierType ?? ph?.listingType),
          carrier: ph?.carrier ?? undefined,
          active: true,
          spamRisk: 'low',
          isPrimary: primary ? n === primary : out.length === 0,
        });
      }
    }
    if (primary && !out.some((x) => x.number === primary)) {
      out.unshift({ number: primary, lineType: 'unknown', active: true, spamRisk: 'low', isPrimary: true });
    }
    return out;
  }

  /**
   * Emails from BOTH containers. Verified live shape:
   *   emails.email[]                → string or {emailAddress}
   *   emailRecords.emailRecord[]    → {email: {emailAddress}}
   */
  private emailsOf(person: any): string[] {
    const fromEmails = this.list(person?.emails, 'email').map((e: any) =>
      typeof e === 'string' ? e : e?.emailAddress ?? e?.email,
    );
    const fromRecords = this.list(person?.emailRecords, 'emailRecord').map(
      (r: any) => r?.email?.emailAddress ?? r?.emailAddress ?? (typeof r?.email === 'string' ? r.email : null),
    );
    return [
      ...new Set(
        [...fromEmails, ...fromRecords]
          .filter((e: any): e is string => typeof e === 'string' && e.includes('@'))
          .map((e) => e.toLowerCase()),
      ),
    ];
  }

  /**
   * Relatives from relationships.relationship[]. Verified live shape:
   *   { relationshipType, name: {firstName, lastName, ...}, currentAge }
   */
  private relativesOf(person: any): Array<{ name: string; relation?: string }> {
    const out: Array<{ name: string; relation?: string }> = [];
    for (const r of this.list(person?.relationships, 'relationship')) {
      const n = r?.name ?? r;
      const full = `${n?.firstName ?? ''} ${[n?.lastName, n?.nameSuffix].filter(Boolean).join(' ')}`.trim();
      if (full) out.push({ name: full, relation: r?.relationshipType ?? undefined });
    }
    return out;
  }

  async searchPerson(query: PersonSearchQuery): Promise<PersonMatch[]> {
    if (!query.phone) return [];
    const json = await this.reversePhone(query.phone);
    return this.records(json).map((person) => {
      const nm = this.nameOf(person);
      const addrs = this.addressesOf(person);
      const current = addrs[0];
      return {
        firstName: nm.first || 'Unknown',
        lastName: nm.last || 'Contact',
        phones: this.phonesOf(person, this.e164(query.phone!)).map((ph) => ({ number: ph.number, lineType: ph.lineType, isPrimary: ph.isPrimary })),
        address: current?.line1 ?? null,
        city: current?.city ?? null,
        state: current?.state ?? null,
        zip: current?.zip ?? null,
        ageRange: this.ageFromDobs(person),
        relatives: this.relativesOf(person).map((x) => x.name),
        confidence: nm.first ? 88 : 45,
        sourceProvider: this.code,
      } as PersonMatch;
    });
  }

  async enrichPerson(input: { phone: string; firstName: string; lastName: string; zip?: string | null }): Promise<PersonEnrichment> {
    const json = await this.reversePhone(input.phone);
    const person = this.records(json)[0] ?? {};
    const primary = this.e164(input.phone);
    const nm = this.nameOf(person);

    return {
      aliases: this.aliasesOf(person, nm.full),
      addresses: this.addressesOf(person),
      phones: this.phonesOf(person, primary),
      emails: this.emailsOf(person),
      ageRange: this.ageFromDobs(person),
      relatives: this.relativesOf(person),
      associates: [],
      property: { ownership: 'unknown' },
      socialUrls: [], // SearchBug people search returns no social; never fetched
      providerConfidence: nm.first ? 0.9 : 0.4,
      sourceProvider: this.code,
    };
  }

  /**
   * Parse a Background Report (api_back) into a clean, regulated-data shape.
   * Defensive across SearchBug's nesting; unknown sections come back empty.
   * The identity block reuses the same parsers as reverse phone.
   */
  parseBackground(json: any): {
    identity: { name: string; dob: string | null; addresses: PersonEnrichment['addresses'] };
    criminalRecords: Array<Record<string, string>>;
    vehicles: Array<Record<string, string>>;
    civil: { bankruptcies: number; liens: number; judgments: number };
  } {
    const person = this.records(json)[0] ?? json?.people?.person ?? json ?? {};
    const nm = this.nameOf(person);
    const dobRaw = this.list(person?.DOBs, 'DOB')[0];

    const crim = [
      ...this.list(person?.criminalRecords, 'criminalRecord'),
      ...this.list(person?.criminalRecords, 'record'),
      ...this.list(json?.criminalRecords, 'criminalRecord'),
    ];
    const criminalRecords = crim.map((c: any) => ({
      offense: c?.offenseDescription ?? c?.offense ?? '',
      caseNumber: c?.caseNumber ?? '',
      caseType: c?.caseType ?? '',
      category: c?.category ?? '',
      state: c?.state ?? '',
      county: c?.county ?? '',
      agency: c?.arrestingAgency ?? '',
      status: c?.status ?? '',
      disposition: c?.disposition ?? '',
      arrestDate: c?.arrestDate ?? '',
      offenseDate: c?.offenseDate ?? '',
    }));

    const veh = [
      ...this.list(person?.vehicles, 'vehicle'),
      ...this.list(json?.vehicles, 'vehicle'),
    ];
    const vehicles = veh.map((v: any) => ({
      vin: v?.VIN ?? v?.vin ?? '',
      make: v?.make ?? '',
      model: v?.model ?? '',
      year: String(v?.year ?? ''),
      type: v?.type ?? '',
      color: v?.primaryColor ?? v?.color ?? '',
      bodyStyle: v?.bodyStyle ?? '',
    }));

    const cr = person?.civilRecords ?? json?.civilRecords ?? {};
    return {
      identity: { name: nm.full, dob: typeof dobRaw === 'string' ? dobRaw : null, addresses: this.addressesOf(person) },
      criminalRecords: criminalRecords.filter((c) => c.offense || c.caseNumber),
      vehicles: vehicles.filter((v) => v.vin || v.make),
      civil: {
        bankruptcies: Number(cr?.numberOfBankruptcies ?? 0) || 0,
        liens: Number(cr?.numberOfLiens ?? 0) || 0,
        judgments: Number(cr?.numberOfJudgments ?? 0) || 0,
      },
    };
  }
}
