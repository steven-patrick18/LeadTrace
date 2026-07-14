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

  private async creds(): Promise<{ apiKey: string; coCode?: string }> {
    const p = await this.prisma.providerSetting.findUnique({ where: { code: this.code } });
    if (!p?.apiKey) throw new Error('SearchBug needs an API Key (paste your key as API Key; optional Account CO_CODE as API Secret)');
    return { apiKey: p.apiKey, coCode: p.apiSecret || undefined };
  }

  private async reversePhone(phone: string): Promise<any> {
    const { apiKey, coCode } = await this.creds();
    const digits = phone.replace(/\D/g, '').replace(/^1(?=\d{10}$)/, '');
    const qs = new URLSearchParams({ TYPE_API: 'api_ppl', F: digits, FORMAT: 'JSON' });
    // CO_CODE/PASS query auth is supported alongside the Bearer header for
    // accounts provisioned that way; the header is the documented default.
    if (coCode) {
      qs.set('CO_CODE', coCode);
      qs.set('PASS', apiKey);
    }
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 20000);
    try {
      const res = await fetch(`${this.base}?${qs.toString()}`, {
        headers: { Authorization: `Bearer ${apiKey}`, Accept: 'application/json' },
        signal: ctrl.signal,
      });
      const text = await res.text();
      let json: any = {};
      try {
        json = JSON.parse(text);
      } catch {
        throw new Error(`SearchBug returned non-JSON (${res.status}) — check TYPE_API/credentials`);
      }
      if (!res.ok) throw new Error(`SearchBug ${res.status}: ${json?.error || json?.ERROR || res.statusText}`);
      if (json?.error || json?.ERROR) throw new Error(`SearchBug: ${json.error || json.ERROR}`);
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

  /** SearchBug nests the person under several possible keys. */
  private records(json: any): any[] {
    const arr = json?.records ?? json?.people ?? json?.results ?? json?.data ?? json?.person ?? json?.RECORDS;
    if (Array.isArray(arr)) return arr;
    if (arr && typeof arr === 'object') return [arr];
    // Root itself may be the person record.
    return json?.firstName || json?.lastName ? [json] : [];
  }

  private ageFromDob(dob: any): string | null {
    const y = Number(dob?.year ?? dob?.YEAR);
    if (!y || y < 1900 || y > 2025) return null;
    const age = 2026 - y; // reference year; approximate band is enough for scoring
    return `${Math.max(0, age - 1)}-${age + 1}`;
  }

  private addressesOf(p: any): PersonEnrichment['addresses'] {
    const raw = Array.isArray(p?.addresses) ? p.addresses : p?.address ? [p.address] : [];
    return raw
      .map((a: any, i: number) => ({
        line1: a?.line1 ?? a?.address ?? [a?.houseNumber, a?.streetName].filter(Boolean).join(' ') ?? '',
        city: a?.city ?? '',
        state: a?.state ?? '',
        zip: [a?.zip, a?.zip4].filter(Boolean).join('-') || a?.zip || '',
        type: (i === 0 ? 'current' : 'past') as 'current' | 'past',
      }))
      .filter((a: any) => a.line1 || a.city);
  }

  private phonesOf(p: any, primary: string | null): PersonEnrichment['phones'] {
    const out: PersonEnrichment['phones'] = [];
    if (primary) out.push({ number: primary, lineType: 'unknown', active: true, spamRisk: 'low', isPrimary: true });
    for (const ph of Array.isArray(p?.phones) ? p.phones : []) {
      const n = this.e164(ph?.phoneNumber ?? ph?.number ?? ph);
      if (n && !out.some((x) => x.number === n)) {
        out.push({
          number: n,
          lineType: this.lineType(ph?.lineType ?? ph?.type),
          active: ph?.status ? !/disconn/i.test(String(ph.status)) : true,
          spamRisk: 'low',
          isPrimary: out.length === 0,
        });
      }
    }
    return out;
  }

  private nameOf(r: any): { first: string; last: string; full: string } {
    const n = r?.name ?? r;
    const first = n?.firstName ?? n?.first ?? '';
    const last = n?.lastName ?? n?.last ?? '';
    return { first, last, full: `${first} ${last}`.trim() };
  }

  private relativesOf(p: any): Array<{ name: string }> {
    return (Array.isArray(p?.relatives) ? p.relatives : [])
      .map((r: any) => ({ name: this.nameOf(r).full }))
      .filter((r: { name: string }) => r.name);
  }

  async searchPerson(query: PersonSearchQuery): Promise<PersonMatch[]> {
    if (!query.phone) return [];
    const json = await this.reversePhone(query.phone);
    return this.records(json).map((r) => {
      const nm = this.nameOf(r);
      const a = (Array.isArray(r?.addresses) ? r.addresses[0] : r?.address) ?? {};
      return {
        firstName: nm.first || 'Unknown',
        lastName: nm.last || 'Contact',
        phones: this.phonesOf(r, this.e164(query.phone!)).map((ph) => ({ number: ph.number, lineType: ph.lineType, isPrimary: ph.isPrimary })),
        address: a?.line1 ?? null,
        city: a?.city ?? null,
        state: a?.state ?? null,
        zip: a?.zip ?? null,
        ageRange: this.ageFromDob(r?.DOB ?? r?.dob),
        relatives: this.relativesOf(r).map((x) => x.name),
        confidence: nm.first ? 85 : 45,
        sourceProvider: this.code,
      } as PersonMatch;
    });
  }

  async enrichPerson(input: { phone: string; firstName: string; lastName: string; zip?: string | null }): Promise<PersonEnrichment> {
    const json = await this.reversePhone(input.phone);
    const r = this.records(json)[0] ?? {};
    const primary = this.e164(input.phone);
    const emails = (Array.isArray(r?.emails) ? r.emails : [])
      .map((e: any) => (typeof e === 'string' ? e : e?.email))
      .filter((e: any) => typeof e === 'string' && e.includes('@'));

    return {
      aliases: (Array.isArray(r?.aka) ? r.aka : []).map((a: any) => this.nameOf(a).full).filter(Boolean),
      addresses: this.addressesOf(r),
      phones: this.phonesOf(r, primary),
      emails,
      ageRange: this.ageFromDob(r?.DOB ?? r?.dob),
      relatives: this.relativesOf(r),
      associates: [],
      property: { ownership: 'unknown' },
      socialUrls: [], // SearchBug people search returns no social; never fetched
      providerConfidence: this.nameOf(r).first ? 0.88 : 0.4,
      sourceProvider: this.code,
    };
  }
}
