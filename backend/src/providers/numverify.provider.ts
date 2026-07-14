import { Injectable, Logger } from '@nestjs/common';
import { CountryCode, parsePhoneNumberFromString } from 'libphonenumber-js';
import { PrismaService } from '../common/prisma.service';
import { EnrichmentDataProvider, PersonEnrichment } from '../enrichment/enrichment.types';
import { PersonDataProvider, PersonMatch, PersonSearchQuery } from './provider.interface';

/**
 * NumVerify (apilayer) — the easiest phone-validation API: instant free key,
 * 100 lookups/month free. Returns validity, line type, carrier, country and
 * location. Phone quality only (no identity). Auth: access_key query param.
 * Docs: https://numverify.com/documentation
 */
@Injectable()
export class NumverifyProvider implements PersonDataProvider, EnrichmentDataProvider {
  readonly code = 'NUMVERIFY';
  private readonly logger = new Logger(NumverifyProvider.name);
  private readonly base = process.env.NUMVERIFY_BASE_URL || 'https://apilayer.net/api/validate';
  private readonly region = (process.env.DEFAULT_PHONE_REGION || 'US') as CountryCode;

  constructor(private readonly prisma: PrismaService) {}

  private async apiKey(): Promise<string> {
    const p = await this.prisma.providerSetting.findUnique({ where: { code: this.code } });
    if (!p?.apiKey) throw new Error('NumVerify access key is not configured');
    return p.apiKey;
  }

  private e164(v: unknown): string | null {
    if (typeof v !== 'string') return null;
    const p = parsePhoneNumberFromString(v.trim(), this.region);
    return p && p.isValid() ? p.number : null;
  }

  private lineType(t: unknown): 'mobile' | 'landline' | 'voip' | 'unknown' {
    const s = String(t ?? '').toLowerCase();
    if (s.includes('mobile')) return 'mobile';
    if (s.includes('landline') || s.includes('fixed_line')) return 'landline';
    if (s.includes('voip')) return 'voip';
    return 'unknown';
  }

  private async lookup(phone: string): Promise<any> {
    const key = await this.apiKey();
    const digits = phone.replace(/\D/g, '');
    const qs = new URLSearchParams({ access_key: key, number: digits, country_code: this.region });
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 20000);
    try {
      const res = await fetch(`${this.base}?${qs}`, { signal: ctrl.signal });
      const json = await res.json().catch(() => ({}));
      if (json?.success === false) throw new Error(`NumVerify: ${json?.error?.info || 'request failed'}`);
      return json;
    } finally {
      clearTimeout(timer);
    }
  }

  /** Phone validation only — contributes phone quality via enrichment, not search. */
  async searchPerson(_query: PersonSearchQuery): Promise<PersonMatch[]> {
    return [];
  }

  async enrichPerson(input: { phone: string; firstName: string; lastName: string; zip?: string | null }): Promise<PersonEnrichment> {
    const j = await this.lookup(input.phone);
    const number = this.e164(j?.international_format) ?? this.e164(input.phone) ?? input.phone;
    return {
      aliases: [],
      addresses: [],
      phones: [
        {
          number,
          lineType: this.lineType(j?.line_type),
          carrier: j?.carrier || undefined,
          active: j?.valid !== false,
          spamRisk: 'low',
          isPrimary: true,
        },
      ],
      emails: [],
      ageRange: null,
      relatives: [],
      associates: [],
      property: { ownership: 'unknown' },
      socialUrls: [],
      providerConfidence: j?.valid ? 0.6 : 0.3,
      sourceProvider: this.code,
    };
  }
}
