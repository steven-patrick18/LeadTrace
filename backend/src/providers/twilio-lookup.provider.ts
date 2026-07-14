import { Injectable, Logger } from '@nestjs/common';
import { CountryCode, parsePhoneNumberFromString } from 'libphonenumber-js';
import { PrismaService } from '../common/prisma.service';
import { EnrichmentDataProvider, PersonEnrichment } from '../enrichment/enrichment.types';
import { PersonDataProvider, PersonMatch, PersonSearchQuery } from './provider.interface';

/**
 * Twilio Lookup v2 — instant pay-as-you-go account, one of the easiest APIs to
 * get. Returns caller-ID name (CNAM → a reverse-phone identity), line type and
 * carrier. Auth: HTTP Basic with Account SID (API key) + Auth Token (secret).
 * Docs: https://www.twilio.com/docs/lookup/v2-api
 */
@Injectable()
export class TwilioLookupProvider implements PersonDataProvider, EnrichmentDataProvider {
  readonly code = 'TWILIO_LOOKUP';
  private readonly logger = new Logger(TwilioLookupProvider.name);
  private readonly base = process.env.TWILIO_LOOKUP_BASE_URL || 'https://lookups.twilio.com/v2/PhoneNumbers';
  private readonly region = (process.env.DEFAULT_PHONE_REGION || 'US') as CountryCode;

  constructor(private readonly prisma: PrismaService) {}

  private async creds(): Promise<{ sid: string; token: string }> {
    const p = await this.prisma.providerSetting.findUnique({ where: { code: this.code } });
    if (!p?.apiKey || !p?.apiSecret) throw new Error('Twilio needs Account SID (API key) + Auth Token (secret)');
    return { sid: p.apiKey, token: p.apiSecret };
  }

  private e164(v: unknown): string | null {
    if (typeof v !== 'string') return null;
    const p = parsePhoneNumberFromString(v.trim(), this.region);
    return p && p.isValid() ? p.number : null;
  }

  private lineType(t: unknown): 'mobile' | 'landline' | 'voip' | 'unknown' {
    const s = String(t ?? '').toLowerCase();
    if (s.includes('mobile')) return 'mobile';
    if (s.includes('landline') || s.includes('fixed')) return 'landline';
    if (s.includes('voip') || s.includes('nonFixedVoip'.toLowerCase()) || s.includes('voip')) return 'voip';
    return 'unknown';
  }

  private async lookup(phone: string): Promise<any> {
    const { sid, token } = await this.creds();
    const e164 = this.e164(phone) ?? phone;
    const auth = Buffer.from(`${sid}:${token}`).toString('base64');
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 20000);
    try {
      const res = await fetch(`${this.base}/${encodeURIComponent(e164)}?Fields=line_type_intelligence,caller_name`, {
        headers: { Authorization: `Basic ${auth}` },
        signal: ctrl.signal,
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(`Twilio ${res.status}: ${json?.message || res.statusText}`);
      return json;
    } finally {
      clearTimeout(timer);
    }
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
    const callerName = j?.caller_name?.caller_name;
    const { first, last } = this.splitName(callerName);
    const number = this.e164(j?.phone_number) ?? query.phone;
    return [
      {
        firstName: first || 'Unknown',
        lastName: last || 'Contact',
        phones: [{ number, lineType: this.lineType(j?.line_type_intelligence?.type), isPrimary: true }],
        address: null,
        city: null,
        state: null,
        zip: null,
        ageRange: null,
        relatives: [],
        confidence: callerName ? 78 : 40,
        sourceProvider: this.code,
      },
    ];
  }

  async enrichPerson(input: { phone: string; firstName: string; lastName: string; zip?: string | null }): Promise<PersonEnrichment> {
    const j = await this.lookup(input.phone);
    const number = this.e164(j?.phone_number) ?? this.e164(input.phone) ?? input.phone;
    const callerName = j?.caller_name?.caller_name;
    const cn = this.splitName(callerName);
    const sameAsLead = `${cn.first} ${cn.last}`.trim().toLowerCase() === `${input.firstName} ${input.lastName}`.trim().toLowerCase();

    return {
      aliases: callerName && !sameAsLead ? [`${cn.first} ${cn.last}`.trim()] : [],
      addresses: [],
      phones: [
        {
          number,
          lineType: this.lineType(j?.line_type_intelligence?.type),
          carrier: j?.line_type_intelligence?.carrier_name ?? undefined,
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
      providerConfidence: callerName ? 0.82 : j?.valid ? 0.6 : 0.3,
      sourceProvider: this.code,
    };
  }
}
