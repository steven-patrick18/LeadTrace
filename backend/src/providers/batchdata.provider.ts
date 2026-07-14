import { Injectable, Logger } from '@nestjs/common';
import { CountryCode, parsePhoneNumberFromString } from 'libphonenumber-js';
import { PrismaService } from '../common/prisma.service';
import {
  EnrichmentDataProvider,
  PersonEnrichment,
} from '../enrichment/enrichment.types';
import { PersonDataProvider, PersonMatch, PersonSearchQuery } from './provider.interface';

/**
 * BatchData (BatchSkipTracing) adapter — property/person skip-tracing.
 * Docs: https://developer.batchdata.com
 *
 * BatchData is primarily a SKIP-TRACE service (name + address → contact info),
 * so its natural fit is lead ENRICHMENT. searchPerson is best-effort: with a
 * name (+zip) we run a skip-trace; phone-only queries return nothing (BatchData
 * isn't a reverse-phone search here).
 *
 * The API key is read from provider_settings at call time and used only in the
 * Authorization header — never returned to the browser or logged.
 * All parsing is defensive: BatchData's response nests contact data in several
 * possible shapes, so every field access tolerates absence.
 */
@Injectable()
export class BatchDataProvider implements PersonDataProvider, EnrichmentDataProvider {
  readonly code = 'BATCHDATA';
  private readonly logger = new Logger(BatchDataProvider.name);
  private readonly base = process.env.BATCHDATA_BASE_URL || 'https://api.batchdata.com/api/v1';
  private readonly region = (process.env.DEFAULT_PHONE_REGION || 'US') as CountryCode;

  constructor(private readonly prisma: PrismaService) {}

  private async apiKey(): Promise<string> {
    const p = await this.prisma.providerSetting.findUnique({ where: { code: this.code } });
    if (!p?.apiKey) throw new Error('BatchData API key is not configured');
    return p.apiKey;
  }

  private async post(path: string, body: unknown): Promise<any> {
    const key = await this.apiKey();
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 20000);
    try {
      const res = await fetch(`${this.base}${path}`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: ctrl.signal,
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        const msg = json?.status?.message || res.statusText;
        // Surface the actionable ones cleanly; the service marks the run PARTIAL.
        throw new Error(`BatchData ${res.status}: ${msg}`);
      }
      return json;
    } finally {
      clearTimeout(timer);
    }
  }

  // ── helpers ────────────────────────────────────────────────
  private e164(input: unknown): string | null {
    if (typeof input !== 'string' || !input.trim()) return null;
    const parsed = parsePhoneNumberFromString(input.trim(), this.region);
    return parsed && parsed.isValid() ? parsed.number : null;
  }

  private lineType(t: unknown): 'mobile' | 'landline' | 'voip' | 'unknown' {
    const s = String(t ?? '').toLowerCase();
    if (s.includes('mobile') || s.includes('cell') || s.includes('wireless')) return 'mobile';
    if (s.includes('land') || s.includes('fixed')) return 'landline';
    if (s.includes('voip')) return 'voip';
    return 'unknown';
  }

  /** Pull the persons array out of whatever nesting BatchData used. */
  private persons(json: any): any[] {
    return (
      json?.results?.persons ??
      json?.results?.[0]?.persons ??
      json?.data?.persons ??
      json?.persons ??
      (Array.isArray(json?.results) ? json.results : []) ??
      []
    );
  }

  private mapPhones(person: any) {
    const raw = person?.phoneNumbers ?? person?.phones ?? [];
    const phones = (Array.isArray(raw) ? raw : [])
      .map((p: any, i: number) => {
        const number = this.e164(p?.number ?? p?.phoneNumber ?? p);
        if (!number) return null;
        return {
          number,
          lineType: this.lineType(p?.type ?? p?.lineType),
          carrier: p?.carrier ?? undefined,
          dnc: p?.dnc === true || p?.dnc?.value === true,
          reachable: p?.reachable ?? p?.score,
          isPrimary: i === 0,
        };
      })
      .filter(Boolean) as Array<{ number: string; lineType: any; carrier?: string; dnc: boolean; reachable: any; isPrimary: boolean }>;
    return phones;
  }

  private mapEmails(person: any): string[] {
    const raw = person?.emails ?? person?.emailAddresses ?? [];
    return (Array.isArray(raw) ? raw : [])
      .map((e: any) => (typeof e === 'string' ? e : e?.email))
      .filter((e: any) => typeof e === 'string' && e.includes('@'));
  }

  // ── PersonDataProvider: search (best-effort skip-trace) ────
  async searchPerson(query: PersonSearchQuery): Promise<PersonMatch[]> {
    if (!query.lastName) return []; // skip-trace needs a name
    const req: any = { name: { first: query.firstName ?? '', last: query.lastName } };
    if (query.zip) req.propertyAddress = { zip: query.zip };
    const json = await this.post('/property/skip-trace', { requests: [req] });

    return this.persons(json).map((person: any) => {
      const phones = this.mapPhones(person);
      const addr = person?.propertyAddress ?? person?.mailingAddress ?? {};
      return {
        firstName: person?.name?.first ?? query.firstName ?? '',
        lastName: person?.name?.last ?? query.lastName ?? '',
        phones: phones.map((p) => ({ number: p.number, lineType: p.lineType, isPrimary: p.isPrimary })),
        address: addr?.street ?? null,
        city: addr?.city ?? null,
        state: addr?.state ?? null,
        zip: addr?.zip ?? null,
        ageRange: person?.demographics?.age ? String(person.demographics.age) : null,
        relatives: (person?.relatives ?? []).map((r: any) => r?.name?.full ?? r?.name ?? String(r)).filter(Boolean),
        confidence: Math.round((person?.matchScore ?? person?.score ?? 0.7) * (person?.matchScore <= 1 ? 100 : 1)) || 70,
        sourceProvider: this.code,
      } as PersonMatch;
    });
  }

  // ── EnrichmentDataProvider: enrich ─────────────────────────
  async enrichPerson(input: { phone: string; firstName: string; lastName: string; zip?: string | null }): Promise<PersonEnrichment> {
    const req: any = { name: { first: input.firstName, last: input.lastName } };
    if (input.zip) req.propertyAddress = { zip: input.zip };
    const json = await this.post('/property/skip-trace', { requests: [req] });
    const person = this.persons(json)[0] ?? {};

    const phones = this.mapPhones(person);
    // Ensure the lead's own phone is present as primary
    const own = this.e164(input.phone);
    if (own && !phones.some((p) => p.number === own)) {
      phones.unshift({ number: own, lineType: 'unknown', carrier: undefined, dnc: false, reachable: undefined, isPrimary: true });
    }
    const addr = person?.propertyAddress ?? person?.mailingAddress ?? {};

    return {
      aliases: (person?.aliases ?? []).map((a: any) => a?.full ?? String(a)).filter(Boolean),
      addresses: [addr, person?.mailingAddress]
        .filter((a: any) => a?.street)
        .map((a: any, i: number) => ({
          line1: a.street,
          city: a.city ?? '',
          state: a.state ?? '',
          zip: a.zip ?? '',
          type: i === 0 ? 'current' : 'past',
        })),
      phones: phones.map((p) => ({
        number: p.number,
        lineType: p.lineType,
        carrier: p.carrier,
        active: p.reachable !== false,
        spamRisk: p.dnc ? 'high' : 'low',
        isPrimary: p.isPrimary,
      })),
      emails: this.mapEmails(person),
      ageRange: person?.demographics?.age ? String(person.demographics.age) : null,
      relatives: (person?.relatives ?? []).map((r: any) => ({ name: r?.name?.full ?? r?.name ?? String(r) })).filter((r: any) => r.name),
      associates: (person?.associates ?? []).map((a: any) => ({ name: a?.name?.full ?? a?.name ?? String(a) })).filter((a: any) => a.name),
      property: {
        ownership: person?.property?.ownerOccupied === true ? 'own' : person?.property?.ownerOccupied === false ? 'rent' : 'unknown',
        estValue: person?.property?.estimatedValue ?? undefined,
        type: person?.property?.type ?? undefined,
      },
      socialUrls: [], // BatchData skip-trace does not return social; never fetched
      providerConfidence: typeof person?.matchScore === 'number' ? Math.min(1, person.matchScore) : phones.length ? 0.8 : 0.3,
      sourceProvider: this.code,
    };
  }
}
