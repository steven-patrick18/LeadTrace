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

  private async reversePhone(phone: string): Promise<any> {
    const { apiKey, coCode } = await this.creds();
    const digits = phone.replace(/\D/g, '').replace(/^1(?=\d{10}$)/, '');
    // Format verified against the LIVE API (their error messages are explicit):
    // auth is CO_CODE + PASS as QUERY params, and the search selector is
    // TYPE=api_ppl (TYPE_API is only used by the status endpoint).
    const qs = new URLSearchParams({
      CO_CODE: coCode,
      PASS: apiKey,
      TYPE: 'api_ppl',
      F: digits,
      FORMAT: 'JSON',
    });
    // Browser-like User-Agent keeps their Cloudflare edge from challenging the request.
    const headers: Record<string, string> = {
      Accept: 'application/json',
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
    };

    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 20000);
    try {
      const res = await fetch(`${this.base}?${qs.toString()}`, { headers, signal: ctrl.signal });
      const text = await res.text();
      // A Cloudflare challenge (HTML, not JSON) means the request was blocked at
      // the edge before reaching the API — ask SearchBug support to allowlist
      // this server's IP (already done once; re-check if it recurs).
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
      // Live error shape: {"Status":"Error","Data":null,"Error":"..."}
      const errMsg = json?.Error || json?.error || json?.ERROR;
      if (errMsg) throw new Error(`SearchBug: ${errMsg}`);
      if (!res.ok) throw new Error(`SearchBug ${res.status}: ${res.statusText}`);
      return json;
    } finally {
      clearTimeout(timer);
    }
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

  /** Age band from DOBs.DOB[] (["MM/DD/YYYY", ...]). */
  private ageFromDobs(person: any): string | null {
    const dobs = this.list(person?.DOBs, 'DOB').map((d: any) => this.ts(d)).filter(Boolean).sort();
    if (!dobs.length) return null;
    const year = new Date(dobs[0]).getUTCFullYear();
    if (year < 1900 || year > 2020) return null;
    const age = 2026 - year;
    return `${Math.max(0, age - 2)}-${age + 2}`;
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

  /** emails: null | {email:[...]} ; emailRecords may also carry addresses. */
  private emailsOf(person: any): string[] {
    const raw = [...this.list(person?.emails, 'email'), ...this.list(person?.emailRecords, 'emailRecord')];
    return [
      ...new Set(
        raw
          .map((e: any) => (typeof e === 'string' ? e : e?.email ?? e?.emailAddress ?? e?.address))
          .filter((e: any): e is string => typeof e === 'string' && e.includes('@'))
          .map((e) => e.toLowerCase()),
      ),
    ];
  }

  /** relationships → relatives (defensive; SearchBug nests names inside). */
  private relativesOf(person: any): Array<{ name: string }> {
    const rels = this.list(person?.relationships, 'relationship');
    const out: Array<{ name: string }> = [];
    for (const r of rels) {
      const nm = this.nameOf(r);
      const full = nm.full || `${r?.firstName ?? ''} ${r?.lastName ?? ''}`.trim();
      if (full) out.push({ name: full });
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
}
