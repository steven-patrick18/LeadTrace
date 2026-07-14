import { Injectable, Logger } from '@nestjs/common';
import { CountryCode, parsePhoneNumberFromString } from 'libphonenumber-js';
import { PrismaService } from '../common/prisma.service';
import { EnrichmentDataProvider, PersonEnrichment } from '../enrichment/enrichment.types';
import { PersonDataProvider, PersonMatch, PersonSearchQuery } from './provider.interface';

/**
 * Melissa Personator Consumer adapter — identity verify + contact append.
 * Docs: https://docs.melissa.com  · Auth: `id=<licenseKey>` query param.
 *
 * Personator verifies/appends against a record you already hold (name +
 * address), so it fits ENRICHMENT better than open search. We request the
 * fullest column set (`cols=GrpAll`) with all actions (Check, Verify, Append,
 * Move) to pull the maximum detail per call, and the app caches it — raise this
 * provider's cache TTL to build your base database and cut repeat cost.
 *
 * Melissa signals problems in TransmissionResults (e.g. GE05 = license
 * disabled/expired); we surface those as errors so the merge skips Melissa and
 * keeps the other providers (PARTIAL).
 */
@Injectable()
export class MelissaProvider implements PersonDataProvider, EnrichmentDataProvider {
  readonly code = 'MELISSA';
  private readonly logger = new Logger(MelissaProvider.name);
  private readonly base =
    process.env.MELISSA_BASE_URL || 'https://personator.melissadata.net/v3/WEB/ContactVerify/doContactVerify';
  private readonly region = (process.env.DEFAULT_PHONE_REGION || 'US') as CountryCode;

  constructor(private readonly prisma: PrismaService) {}

  private async apiKey(): Promise<string> {
    const p = await this.prisma.providerSetting.findUnique({ where: { code: this.code } });
    if (!p?.apiKey) throw new Error('Melissa license key is not configured');
    return p.apiKey;
  }

  private async call(params: Record<string, string>): Promise<any> {
    const key = await this.apiKey();
    const qs = new URLSearchParams({
      id: key,
      format: 'json',
      act: 'Check,Verify,Append,Move',
      cols: 'GrpAll',
      ...params,
    });
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 20000);
    try {
      const res = await fetch(`${this.base}?${qs}`, { signal: ctrl.signal });
      const json = await res.json().catch(() => ({}));
      // Transmission-level failures (bad/disabled license, quota) live here.
      const tr = json?.TransmissionResults ?? '';
      if (tr && tr !== ' ' && !tr.includes('GE00')) {
        throw new Error(`Melissa transmission ${tr} (e.g. GE05 = license disabled/expired)`);
      }
      return json;
    } finally {
      clearTimeout(timer);
    }
  }

  private e164(v: unknown): string | null {
    if (typeof v !== 'string' || !v.trim()) return null;
    const p = parsePhoneNumberFromString(v.trim(), this.region);
    return p && p.isValid() ? p.number : null;
  }

  private splitName(full: unknown, first?: string, last?: string) {
    if (first || last) return { first: first ?? '', last: last ?? '' };
    const s = String(full ?? '').trim();
    if (!s) return { first: '', last: '' };
    const parts = s.split(/\s+/);
    return { first: parts[0], last: parts.slice(1).join(' ') };
  }

  private recordToEnrichment(rec: any, fallbackPhone: string): PersonEnrichment {
    const phoneNums = [rec?.PhoneNumber, rec?.Phone, rec?.MobilePhone]
      .map((p) => this.e164(p))
      .filter(Boolean) as string[];
    if (fallbackPhone && !phoneNums.includes(fallbackPhone)) phoneNums.unshift(fallbackPhone);
    const emails = [rec?.EmailAddress, rec?.Email].filter((e) => typeof e === 'string' && e.includes('@'));

    return {
      aliases: [],
      addresses: rec?.AddressLine1
        ? [{ line1: rec.AddressLine1, city: rec.City ?? '', state: rec.State ?? '', zip: rec.PostalCode ?? '', type: 'current' }]
        : [],
      phones: phoneNums.map((number, i) => ({
        number,
        lineType: 'unknown' as const,
        carrier: undefined,
        active: true,
        spamRisk: 'low' as const,
        isPrimary: i === 0,
      })),
      emails,
      ageRange: rec?.DemographicsAge ?? rec?.Age ?? null,
      relatives: [],
      associates: [],
      property: { ownership: rec?.DemographicsOwnRent === 'O' ? 'own' : rec?.DemographicsOwnRent === 'R' ? 'rent' : 'unknown' },
      socialUrls: [], // Melissa returns no social; never fetched
      // Verified-address / append results raise confidence.
      providerConfidence: String(rec?.Results ?? '').includes('AS01') ? 0.85 : rec?.AddressLine1 ? 0.7 : 0.4,
      sourceProvider: this.code,
    };
  }

  async enrichPerson(input: { phone: string; firstName: string; lastName: string; zip?: string | null }): Promise<PersonEnrichment> {
    const json = await this.call({
      first: input.firstName,
      last: input.lastName,
      phone: input.phone.replace(/\D/g, ''),
      ...(input.zip ? { postal: input.zip } : {}),
    });
    const rec = (json?.Records ?? [])[0] ?? {};
    return this.recordToEnrichment(rec, this.e164(input.phone) ?? input.phone);
  }

  async searchPerson(query: PersonSearchQuery): Promise<PersonMatch[]> {
    if (!query.lastName && !query.phone) return [];
    const name = this.splitName(undefined, query.firstName, query.lastName);
    const json = await this.call({
      first: name.first,
      last: name.last,
      ...(query.phone ? { phone: query.phone.replace(/\D/g, '') } : {}),
      ...(query.zip ? { postal: query.zip } : {}),
    });
    return (json?.Records ?? [])
      .filter((rec: any) => rec?.PhoneNumber?.trim() || rec?.EmailAddress?.trim() || rec?.AddressLine1?.trim())
      .map((rec: any) => {
        const n = this.splitName(rec?.NameFull, rec?.NameFirst, rec?.NameLast);
        const phone = this.e164(rec?.PhoneNumber);
        return {
          firstName: n.first || query.firstName || '',
          lastName: n.last || query.lastName || '',
          phones: phone ? [{ number: phone, lineType: 'unknown', isPrimary: true }] : [],
          address: rec?.AddressLine1 ?? null,
          city: rec?.City ?? null,
          state: rec?.State ?? null,
          zip: rec?.PostalCode ?? null,
          ageRange: rec?.DemographicsAge ?? null,
          relatives: [],
          confidence: String(rec?.Results ?? '').includes('AS01') ? 82 : 60,
          sourceProvider: this.code,
        } as PersonMatch;
      });
  }
}
