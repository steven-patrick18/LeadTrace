import { Injectable, Logger } from '@nestjs/common';
import { CountryCode, parsePhoneNumberFromString } from 'libphonenumber-js';
import { PrismaService } from '../common/prisma.service';
import { EnrichmentDataProvider, PersonEnrichment } from '../enrichment/enrichment.types';
import { PersonDataProvider, PersonMatch, PersonSearchQuery } from './provider.interface';

/**
 * IPQualityScore Phone Validation — instant free key (5,000 lookups/month).
 * Returns validity, active status, line type, carrier, and a FRAUD/SPAM score
 * — great for the callable gate and spam-risk. Occasionally returns a name.
 * Auth: key in the URL path. Docs: https://www.ipqualityscore.com/documentation/phone-number-validation-api/overview
 */
@Injectable()
export class IpqsProvider implements PersonDataProvider, EnrichmentDataProvider {
  readonly code = 'IPQS';
  private readonly logger = new Logger(IpqsProvider.name);
  private readonly base = process.env.IPQS_BASE_URL || 'https://ipqualityscore.com/api/json/phone';
  private readonly region = (process.env.DEFAULT_PHONE_REGION || 'US') as CountryCode;

  constructor(private readonly prisma: PrismaService) {}

  private async apiKey(): Promise<string> {
    const p = await this.prisma.providerSetting.findUnique({ where: { code: this.code } });
    if (!p?.apiKey) throw new Error('IPQualityScore API key is not configured');
    return p.apiKey;
  }

  private e164(v: unknown): string | null {
    if (typeof v !== 'string') return null;
    const p = parsePhoneNumberFromString(v.trim(), this.region);
    return p && p.isValid() ? p.number : null;
  }

  private lineType(t: unknown): 'mobile' | 'landline' | 'voip' | 'unknown' {
    const s = String(t ?? '').toLowerCase();
    if (s.includes('wireless') || s.includes('mobile')) return 'mobile';
    if (s.includes('landline') || s.includes('fixed')) return 'landline';
    if (s.includes('voip')) return 'voip';
    return 'unknown';
  }

  private async lookup(phone: string): Promise<any> {
    const key = await this.apiKey();
    const e164 = this.e164(phone) ?? phone;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 20000);
    try {
      const res = await fetch(`${this.base}/${encodeURIComponent(key)}/${encodeURIComponent(e164)}`, { signal: ctrl.signal });
      const json = await res.json().catch(() => ({}));
      if (json?.success === false) throw new Error(`IPQS: ${json?.message || 'request failed'}`);
      return json;
    } finally {
      clearTimeout(timer);
    }
  }

  private spamRisk(j: any): 'low' | 'med' | 'high' {
    if (j?.recent_abuse || (j?.fraud_score ?? 0) >= 85 || j?.risky) return 'high';
    if ((j?.fraud_score ?? 0) >= 50) return 'med';
    return 'low';
  }

  private splitName(full: unknown): { first: string; last: string } {
    const s = String(full ?? '').trim();
    if (!s) return { first: '', last: '' };
    const tc = (w: string) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase();
    const parts = s.split(/\s+/).map(tc);
    return { first: parts[0] ?? '', last: parts.slice(1).join(' ') };
  }

  async searchPerson(query: PersonSearchQuery): Promise<PersonMatch[]> {
    if (!query.phone) return [];
    const j = await this.lookup(query.phone);
    if (j?.valid === false) return [];
    const { first, last } = this.splitName(j?.name);
    return [
      {
        firstName: first || 'Unknown',
        lastName: last || 'Contact',
        phones: [{ number: this.e164(j?.formatted) ?? query.phone, lineType: this.lineType(j?.line_type), isPrimary: true }],
        address: null,
        city: j?.city ?? null,
        state: j?.region ?? null,
        zip: j?.zip_code ?? null,
        ageRange: null,
        relatives: [],
        confidence: first ? 65 : 40,
        sourceProvider: this.code,
      },
    ];
  }

  async enrichPerson(input: { phone: string; firstName: string; lastName: string; zip?: string | null }): Promise<PersonEnrichment> {
    const j = await this.lookup(input.phone);
    const number = this.e164(j?.formatted) ?? this.e164(input.phone) ?? input.phone;
    const name = this.splitName(j?.name);
    const sameAsLead = `${name.first} ${name.last}`.trim().toLowerCase() === `${input.firstName} ${input.lastName}`.trim().toLowerCase();
    return {
      aliases: j?.name && !sameAsLead ? [`${name.first} ${name.last}`.trim()] : [],
      addresses:
        j?.city || j?.zip_code ? [{ line1: '', city: j?.city ?? '', state: j?.region ?? '', zip: j?.zip_code ?? '', type: 'current' }] : [],
      phones: [
        {
          number,
          lineType: this.lineType(j?.line_type),
          carrier: j?.carrier ?? undefined,
          active: j?.active !== false && j?.valid !== false,
          spamRisk: this.spamRisk(j),
          isPrimary: true,
        },
      ],
      emails: [],
      ageRange: null,
      relatives: [],
      associates: [],
      property: { ownership: 'unknown' },
      socialUrls: [],
      providerConfidence: j?.name ? 0.75 : j?.valid ? 0.6 : 0.3,
      sourceProvider: this.code,
    };
  }
}
