import { Injectable, Logger } from '@nestjs/common';
import { CountryCode, parsePhoneNumberFromString } from 'libphonenumber-js';
import { PrismaService } from '../common/prisma.service';
import { EnrichmentDataProvider, PersonEnrichment } from '../enrichment/enrichment.types';
import { PersonDataProvider, PersonMatch, PersonSearchQuery } from './provider.interface';

/**
 * Endato (Enformion Galaxy) — DEEP reverse-phone / person data: full name,
 * aliases, age, current + historical addresses, associated people, alternate
 * phones and emails. The most information you can get from a phone number on an
 * easy self-serve account.
 *
 * Auth: headers `galaxy-ap-name` (AP Name = API key) + `galaxy-ap-password`
 * (AP Password = API secret) + `galaxy-search-type`. Docs: https://docs.endato.com
 *
 * Endpoint/response shapes vary across Endato products; parsing is defensive.
 * Account issues (bad AP credentials, no balance) throw so the merge skips it.
 */
@Injectable()
export class EndatoProvider implements PersonDataProvider, EnrichmentDataProvider {
  readonly code = 'ENDATO';
  private readonly logger = new Logger(EndatoProvider.name);
  private readonly base = process.env.ENDATO_BASE_URL || 'https://devapi.endato.com';
  private readonly phonePath = process.env.ENDATO_PHONE_PATH || '/Phone/Enrich';
  private readonly searchType = process.env.ENDATO_SEARCH_TYPE || 'Person';
  private readonly region = (process.env.DEFAULT_PHONE_REGION || 'US') as CountryCode;

  constructor(private readonly prisma: PrismaService) {}

  private async creds(): Promise<{ name: string; password: string }> {
    const p = await this.prisma.providerSetting.findUnique({ where: { code: this.code } });
    if (!p?.apiKey || !p?.apiSecret) throw new Error('Endato needs AP Name (API key) + AP Password (API secret)');
    return { name: p.apiKey, password: p.apiSecret };
  }

  private async post(path: string, body: unknown): Promise<any> {
    const { name, password } = await this.creds();
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 20000);
    try {
      const res = await fetch(`${this.base}${path}`, {
        method: 'POST',
        headers: {
          'galaxy-ap-name': name,
          'galaxy-ap-password': password,
          'galaxy-search-type': this.searchType,
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: JSON.stringify(body),
        signal: ctrl.signal,
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(`Endato ${res.status}: ${json?.error?.message || json?.message || res.statusText}`);
      return json;
    } finally {
      clearTimeout(timer);
    }
  }

  private e164(v: unknown): string | null {
    if (typeof v !== 'string') return null;
    const p = parsePhoneNumberFromString(v.trim(), this.region);
    return p && p.isValid() ? p.number : null;
  }

  private lineType(t: unknown): 'mobile' | 'landline' | 'voip' | 'unknown' {
    const s = String(t ?? '').toLowerCase();
    if (s.includes('mobile') || s.includes('wireless') || s.includes('cell')) return 'mobile';
    if (s.includes('land') || s.includes('fixed')) return 'landline';
    if (s.includes('voip')) return 'voip';
    return 'unknown';
  }

  /** Endato nests the person under several possible keys. */
  private person(json: any): any {
    return json?.person ?? json?.persons?.[0] ?? json?.records?.[0] ?? json?.results?.[0] ?? json ?? {};
  }

  private nameOf(p: any): { first: string; last: string; full: string } {
    const n = p?.name ?? p;
    const first = n?.firstName ?? n?.firstname ?? '';
    const last = n?.lastName ?? n?.lastname ?? '';
    const full = n?.fullName ?? `${first} ${last}`.trim();
    return { first, last, full };
  }

  private addressesOf(p: any): PersonEnrichment['addresses'] {
    const arr = p?.addresses ?? p?.addressList ?? [];
    return (Array.isArray(arr) ? arr : [])
      .map((a: any, i: number) => ({
        line1:
          a?.fullAddress ||
          [a?.houseNumber, a?.streetName].filter(Boolean).join(' ') ||
          a?.addressLine1 ||
          '',
        city: a?.city ?? '',
        state: a?.state ?? '',
        zip: a?.zip ?? a?.zipCode ?? a?.postalCode ?? '',
        type: (i === 0 ? 'current' : 'past') as 'current' | 'past',
      }))
      .filter((a: any) => a.line1 || a.city);
  }

  private phonesOf(p: any, primary: string | null): PersonEnrichment['phones'] {
    const arr = p?.phoneNumbers ?? p?.phones ?? [];
    const out: PersonEnrichment['phones'] = [];
    if (primary) out.push({ number: primary, lineType: 'unknown', active: true, spamRisk: 'low', isPrimary: true });
    for (const ph of Array.isArray(arr) ? arr : []) {
      const n = this.e164(ph?.phoneNumber ?? ph?.number ?? ph);
      if (n && !out.some((x) => x.number === n)) {
        out.push({
          number: n,
          lineType: this.lineType(ph?.phoneType ?? ph?.type),
          active: ph?.isConnected !== false,
          spamRisk: 'low',
          isPrimary: out.length === 0,
        });
      }
    }
    return out;
  }

  private namesList(arr: any): Array<{ name: string }> {
    return (Array.isArray(arr) ? arr : [])
      .map((r: any) => {
        const n = this.nameOf(r);
        return { name: n.full || `${n.first} ${n.last}`.trim() };
      })
      .filter((r) => r.name);
  }

  async searchPerson(query: PersonSearchQuery): Promise<PersonMatch[]> {
    if (!query.phone) return [];
    const json = await this.post(this.phonePath, { Phone: query.phone.replace(/\D/g, '') });
    const persons = json?.persons ?? (json?.person ? [json.person] : json?.records ?? []);
    return (Array.isArray(persons) ? persons : []).map((p: any) => {
      const nm = this.nameOf(p);
      const addr = (p?.addresses ?? [])[0] ?? {};
      const phones = this.phonesOf(p, this.e164(query.phone!));
      return {
        firstName: nm.first || 'Unknown',
        lastName: nm.last || 'Contact',
        phones: phones.map((ph) => ({ number: ph.number, lineType: ph.lineType, isPrimary: ph.isPrimary })),
        address: addr?.fullAddress ?? null,
        city: addr?.city ?? null,
        state: addr?.state ?? null,
        zip: addr?.zip ?? addr?.zipCode ?? null,
        ageRange: p?.age ? String(p.age) : null,
        relatives: this.namesList(p?.relatives).map((r) => r.name),
        confidence: nm.first ? 88 : 45,
        sourceProvider: this.code,
      } as PersonMatch;
    });
  }

  async enrichPerson(input: { phone: string; firstName: string; lastName: string; zip?: string | null }): Promise<PersonEnrichment> {
    const json = await this.post(this.phonePath, { Phone: input.phone.replace(/\D/g, '') });
    const p = this.person(json);
    const primary = this.e164(input.phone);

    return {
      aliases: this.namesList(p?.akas ?? p?.aliases).map((a) => a.name),
      addresses: this.addressesOf(p),
      phones: this.phonesOf(p, primary),
      emails: (p?.emailAddresses ?? p?.emails ?? [])
        .map((e: any) => (typeof e === 'string' ? e : e?.emailAddress ?? e?.email))
        .filter((e: any) => typeof e === 'string' && e.includes('@')),
      ageRange: p?.age ? String(p.age) : p?.ageRange ?? null,
      relatives: this.namesList(p?.relatives),
      associates: this.namesList(p?.associates),
      property: { ownership: 'unknown' },
      socialUrls: [], // Endato reverse-phone returns no social; never fetched
      providerConfidence: this.nameOf(p).first ? 0.9 : 0.4,
      sourceProvider: this.code,
    };
  }
}
