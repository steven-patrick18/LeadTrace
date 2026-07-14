import { Injectable, Logger } from '@nestjs/common';
import { CountryCode, parsePhoneNumberFromString } from 'libphonenumber-js';
import { PrismaService } from '../common/prisma.service';
import { EnrichmentDataProvider, PersonEnrichment } from '../enrichment/enrichment.types';
import { PersonDataProvider, PersonMatch, PersonSearchQuery } from './provider.interface';

/**
 * Melissa Global Phone API adapter — reverse phone → caller-ID identity + geo.
 * Endpoint: GET https://globalphone.melissadata.net/v4/WEB/GlobalPhone/doGlobalPhone
 * Auth: `id=<licenseKey>` query param.  Docs: https://docs.melissa.com
 *
 * Global Phone turns a phone number into the CALLER-ID NAME, carrier, line
 * type, and the number's city/county/state/ZIP/timezone — a genuine
 * reverse-phone lookup. That makes Melissa a phone→identity source here:
 * searching a phone returns the owner, and enrichment fills phone quality +
 * location.
 *
 * Result handling: transmission-level failures (GE05 invalid key, GE08 product
 * not enabled / no credits) throw so the enrichment merge skips Melissa and
 * keeps the other providers. Per-record PS result codes indicate validity.
 */
@Injectable()
export class MelissaProvider implements PersonDataProvider, EnrichmentDataProvider {
  readonly code = 'MELISSA';
  private readonly logger = new Logger(MelissaProvider.name);
  private readonly base =
    process.env.MELISSA_BASE_URL || 'https://globalphone.melissadata.net/v4/WEB/GlobalPhone/doGlobalPhone';
  private readonly region = (process.env.DEFAULT_PHONE_REGION || 'US') as CountryCode;

  constructor(private readonly prisma: PrismaService) {}

  private async apiKey(): Promise<string> {
    const p = await this.prisma.providerSetting.findUnique({ where: { code: this.code } });
    if (!p?.apiKey) throw new Error('Melissa license key is not configured');
    return p.apiKey;
  }

  private async lookup(phone: string): Promise<any> {
    const key = await this.apiKey();
    const qs = new URLSearchParams({ id: key, phone, ctry: this.region, format: 'json' });
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 20000);
    try {
      const res = await fetch(`${this.base}?${qs}`, { signal: ctrl.signal });
      const json = await res.json().catch(() => ({}));
      const tr = json?.TransmissionResults ?? '';
      if (tr && tr.trim() && !tr.includes('GE00')) {
        const hint =
          tr.includes('GE05') ? 'invalid license key' :
          tr.includes('GE08') ? 'Global Phone not enabled / no credits on this license' : tr;
        throw new Error(`Melissa ${tr} (${hint})`);
      }
      return (json?.Records ?? [])[0] ?? null;
    } finally {
      clearTimeout(timer);
    }
  }

  private e164(v: unknown): string | null {
    if (typeof v !== 'string' || !v.trim()) return null;
    const p = parsePhoneNumberFromString(v.trim(), this.region);
    return p && p.isValid() ? p.number : null;
  }

  private lineType(t: unknown): 'mobile' | 'landline' | 'voip' | 'unknown' {
    const s = String(t ?? '').toLowerCase();
    if (s.includes('mobile') || s.includes('wireless') || s.includes('cell')) return 'mobile';
    if (s.includes('landline') || s.includes('fixed') || s.includes('land line')) return 'landline';
    if (s.includes('voip')) return 'voip';
    return 'unknown';
  }

  /** Caller ID like "NEIL DORFMAN" → first/last (title-cased). */
  private splitCaller(caller: unknown): { first: string; last: string } {
    const s = String(caller ?? '').trim();
    if (!s) return { first: '', last: '' };
    const tc = (w: string) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase();
    const parts = s.split(/\s+/).map(tc);
    return { first: parts[0] ?? '', last: parts.slice(1).join(' ') };
  }

  private callerName(rec: any): unknown {
    return rec?.Caller ?? rec?.CallerID ?? rec?.CallerId ?? rec?.Name ?? null;
  }

  private isReachable(rec: any): boolean {
    const results = String(rec?.Results ?? '');
    // PS01 = valid line; PS08/PS09 etc. flag issues. Treat as reachable unless
    // an explicit invalid/disconnected code is present.
    return results.includes('PS01') || (!results.includes('PS08') && !results.includes('PS09'));
  }

  async searchPerson(query: PersonSearchQuery): Promise<PersonMatch[]> {
    if (!query.phone) return []; // Global Phone is a reverse-phone lookup
    const rec = await this.lookup(query.phone);
    if (!rec) return [];
    const { first, last } = this.splitCaller(this.callerName(rec));
    const number = this.e164(rec?.PhoneNumber) ?? query.phone;
    return [
      {
        firstName: first || 'Unknown',
        lastName: last || 'Contact',
        phones: [{ number, lineType: this.lineType(rec?.PhoneType), isPrimary: true }],
        address: null,
        city: rec?.Locality ?? null,
        state: rec?.AdministrativeArea ?? null,
        zip: rec?.PostalCode ?? null,
        ageRange: null,
        relatives: [],
        confidence: first ? 80 : 45, // caller-ID name present ⇒ real identity
        sourceProvider: this.code,
      },
    ];
  }

  async enrichPerson(input: { phone: string; firstName: string; lastName: string; zip?: string | null }): Promise<PersonEnrichment> {
    const rec = await this.lookup(input.phone);
    const number = this.e164(rec?.PhoneNumber) ?? this.e164(input.phone) ?? input.phone;
    const caller = this.callerName(rec);
    const callerName = this.splitCaller(caller);

    return {
      // Caller ID that differs from the lead's name is a useful alias.
      aliases:
        caller && `${callerName.first} ${callerName.last}`.trim().toLowerCase() !== `${input.firstName} ${input.lastName}`.trim().toLowerCase()
          ? [`${callerName.first} ${callerName.last}`.trim()]
          : [],
      addresses:
        rec?.Locality || rec?.PostalCode
          ? [{ line1: '', city: rec?.Locality ?? '', state: rec?.AdministrativeArea ?? '', zip: rec?.PostalCode ?? '', type: 'current' }]
          : [],
      phones: [
        {
          number,
          lineType: this.lineType(rec?.PhoneType),
          carrier: rec?.Carrier ?? undefined,
          active: rec ? this.isReachable(rec) : true,
          spamRisk: 'low',
          isPrimary: true,
        },
      ],
      emails: [],
      ageRange: null,
      relatives: [],
      associates: [],
      property: { ownership: 'unknown' },
      socialUrls: [], // Global Phone returns no social; never fetched
      // Caller-ID name present ⇒ strong; otherwise reflects line validity.
      providerConfidence: caller ? 0.85 : rec ? 0.6 : 0.3,
      sourceProvider: this.code,
    };
  }
}
