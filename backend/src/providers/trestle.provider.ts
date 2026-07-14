import { Injectable, Logger } from '@nestjs/common';
import { CountryCode, parsePhoneNumberFromString } from 'libphonenumber-js';
import { PrismaService } from '../common/prisma.service';
import { EnrichmentDataProvider, PersonEnrichment } from '../enrichment/enrichment.types';
import { PersonDataProvider, PersonMatch, PersonSearchQuery } from './provider.interface';

/**
 * Trestle (Whitepages Pro) adapter — Reverse Phone + Find Person.
 * Docs: https://trestle-api.redoc.ly  · Auth: `x-api-key` header.
 *
 * Reverse Phone (3.0/phone) is the richest single call for enrichment: it
 * returns the number's line type/carrier plus every owner with their names,
 * current + historical addresses, associated people, alternate phones and
 * emails. Find Person (3.2/person) drives name/zip search. We request the full
 * record and cache it (the app's per-provider cache is your base database —
 * raise this provider's cache TTL to reduce repeat cost).
 *
 * Key/account issues (invalid key, quota) surface as thrown errors; the
 * enrichment merge skips this provider and keeps the others (PARTIAL).
 */
@Injectable()
export class TrestleProvider implements PersonDataProvider, EnrichmentDataProvider {
  readonly code = 'TRESTLE';
  private readonly logger = new Logger(TrestleProvider.name);
  private readonly base = process.env.TRESTLE_BASE_URL || 'https://api.trestleiq.com';
  private readonly region = (process.env.DEFAULT_PHONE_REGION || 'US') as CountryCode;

  constructor(private readonly prisma: PrismaService) {}

  private async apiKey(): Promise<string> {
    const p = await this.prisma.providerSetting.findUnique({ where: { code: this.code } });
    if (!p?.apiKey) throw new Error('Trestle API key is not configured');
    return p.apiKey;
  }

  private async get(path: string): Promise<any> {
    const key = await this.apiKey();
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 20000);
    try {
      const res = await fetch(`${this.base}${path}`, {
        headers: { 'x-api-key': key, Accept: 'application/json' },
        signal: ctrl.signal,
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(`Trestle ${res.status}: ${json?.message || json?.errorCode || res.statusText}`);
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
    if (s.includes('mobile') || s.includes('cell')) return 'mobile';
    if (s.includes('land') || s.includes('fixed')) return 'landline';
    if (s.includes('voip') || s.includes('nonfixed')) return 'voip';
    return 'unknown';
  }

  private mapOwnerToMatch(owner: any, phoneNumber: string | null, phoneFacts: any): PersonMatch {
    const names = owner?.name ? [owner.name] : owner?.names ?? [];
    const first = owner?.firstname ?? (typeof names[0] === 'string' ? names[0].split(' ')[0] : names[0]?.firstname) ?? '';
    const last = owner?.lastname ?? (typeof names[0] === 'string' ? names[0].split(' ').slice(-1)[0] : names[0]?.lastname) ?? '';
    const addr = (owner?.current_addresses ?? owner?.addresses ?? [])[0] ?? {};
    const phones: PersonMatch['phones'] = [];
    if (phoneNumber) phones.push({ number: phoneNumber, lineType: this.lineType(phoneFacts?.line_type), isPrimary: true });
    for (const p of owner?.phones ?? []) {
      const n = this.e164(p?.phone_number ?? p);
      if (n && !phones.some((x) => x.number === n)) phones.push({ number: n, lineType: this.lineType(p?.line_type), isPrimary: false });
    }
    return {
      firstName: first,
      lastName: last,
      phones,
      address: addr?.street_line_1 ?? addr?.line1 ?? null,
      city: addr?.city ?? null,
      state: addr?.state_code ?? addr?.state ?? null,
      zip: addr?.postal_code ?? addr?.zip ?? null,
      ageRange: owner?.age_range ?? (owner?.age ? String(owner.age) : null),
      relatives: (owner?.associated_people ?? []).map((r: any) => r?.name ?? `${r?.firstname ?? ''} ${r?.lastname ?? ''}`.trim()).filter(Boolean),
      confidence: Math.round((phoneFacts?.is_valid === false ? 0.3 : 0.75) * 100),
      sourceProvider: this.code,
    };
  }

  async searchPerson(query: PersonSearchQuery): Promise<PersonMatch[]> {
    if (query.phone) {
      const j = await this.get(`/3.0/phone?phone=${encodeURIComponent(query.phone)}`);
      const owners = j?.owners ?? [];
      return owners.map((o: any) => this.mapOwnerToMatch(o, this.e164(j?.phone_number) ?? query.phone!, j));
    }
    if (query.lastName) {
      const name = encodeURIComponent(`${query.firstName ?? ''} ${query.lastName}`.trim());
      const zip = query.zip ? `&address.postal_code=${query.zip}` : '';
      const j = await this.get(`/3.2/person?name=${name}${zip}`);
      const people = j?.people ?? j?.person ?? [];
      return (Array.isArray(people) ? people : [people]).map((o: any) => this.mapOwnerToMatch(o, null, null));
    }
    return [];
  }

  async enrichPerson(input: { phone: string; firstName: string; lastName: string; zip?: string | null }): Promise<PersonEnrichment> {
    const j = await this.get(`/3.0/phone?phone=${encodeURIComponent(input.phone)}`);
    const owner = (j?.owners ?? [])[0] ?? {};

    const primary = this.e164(j?.phone_number) ?? this.e164(input.phone) ?? input.phone;
    const phones: PersonEnrichment['phones'] = [
      {
        number: primary,
        lineType: this.lineType(j?.line_type),
        carrier: j?.carrier ?? undefined,
        active: j?.is_valid !== false,
        spamRisk: j?.is_prepaid ? 'med' : 'low',
        isPrimary: true,
      },
    ];
    for (const p of owner?.phones ?? []) {
      const n = this.e164(p?.phone_number ?? p);
      if (n && !phones.some((x) => x.number === n)) {
        phones.push({ number: n, lineType: this.lineType(p?.line_type), carrier: p?.carrier, active: p?.is_valid !== false, spamRisk: 'low', isPrimary: false });
      }
    }

    const addrs = [...(owner?.current_addresses ?? []), ...(owner?.historical_addresses ?? [])];
    return {
      aliases: (owner?.alternate_names ?? []).map((a: any) => (typeof a === 'string' ? a : `${a?.firstname ?? ''} ${a?.lastname ?? ''}`.trim())).filter(Boolean),
      addresses: addrs.filter((a: any) => a?.street_line_1 || a?.line1).map((a: any, i: number) => ({
        line1: a.street_line_1 ?? a.line1,
        city: a.city ?? '',
        state: a.state_code ?? a.state ?? '',
        zip: a.postal_code ?? a.zip ?? '',
        type: i === 0 ? 'current' : 'past',
      })),
      phones,
      emails: (owner?.emails ?? []).map((e: any) => (typeof e === 'string' ? e : e?.email_address ?? e?.email)).filter((e: any) => typeof e === 'string' && e.includes('@')),
      ageRange: owner?.age_range ?? (owner?.age ? String(owner.age) : null),
      relatives: (owner?.associated_people ?? []).map((r: any) => ({ name: r?.name ?? `${r?.firstname ?? ''} ${r?.lastname ?? ''}`.trim() })).filter((r: any) => r.name),
      associates: [],
      property: { ownership: 'unknown' },
      socialUrls: [], // Trestle does not return social; never fetched
      providerConfidence: j?.is_valid === false ? 0.3 : owner?.name ? 0.85 : 0.6,
      sourceProvider: this.code,
    };
  }
}
