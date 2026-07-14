import { Injectable, Logger } from '@nestjs/common';
import { CountryCode, parsePhoneNumberFromString } from 'libphonenumber-js';
import { PrismaService } from '../common/prisma.service';
import { EnrichmentDataProvider, PersonEnrichment } from '../enrichment/enrichment.types';
import { PersonDataProvider, PersonMatch, PersonSearchQuery } from './provider.interface';

/**
 * Trestle (Whitepages Pro) adapter. Uses the two self-serve endpoints most
 * accounts have access to:
 *   • Phone Validation  GET /3.0/phone_intel  ($0.015) — validity, line type,
 *     carrier, activity score, prepaid flag.
 *   • Real Contact      GET /2.0/real_contact ($0.03)  — contact grade A–F and
 *     whether the phone/email matches the given name.
 * Auth: `x-api-key` header. Docs: https://docs.trestleiq.com
 *
 * These return phone/contact QUALITY, not identity — perfect for killing
 * wasted dials and cross-verifying phones another provider supplied. Full
 * identity (owner name + addresses) needs Trestle's Reverse Phone API, which
 * is "Request Access" on self-serve; enable it in the Trestle portal to unlock
 * richer enrichment here later.
 *
 * Account issues (invalid key, no wallet balance, locked product) throw, and
 * the enrichment merge skips Trestle while keeping the other providers.
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
      if (!res.ok) throw new Error(`Trestle ${res.status}: ${json?.message || json?.errorCode || json?.error || res.statusText}`);
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
    if (s.includes('landline') || s.includes('fixed')) return 'landline';
    if (s.includes('voip') || s.includes('nonfixed')) return 'voip';
    return 'unknown';
  }

  private gradeToConfidence(grade: unknown): number | null {
    const map: Record<string, number> = { A: 0.95, B: 0.85, C: 0.7, D: 0.5, F: 0.3 };
    return typeof grade === 'string' && map[grade] !== undefined ? map[grade] : null;
  }

  /** Search: the accessible Trestle endpoints don't reverse a phone into a
   *  person, so Trestle contributes phone quality via enrichment, not search. */
  async searchPerson(_query: PersonSearchQuery): Promise<PersonMatch[]> {
    return [];
  }

  async enrichPerson(input: { phone: string; firstName: string; lastName: string; zip?: string | null }): Promise<PersonEnrichment> {
    const phone = input.phone.replace(/\s/g, '');
    const intel = await this.get(`/3.0/phone_intel?phone=${encodeURIComponent(phone)}`);

    // Real Contact adds a contact grade + name-match when we have a name.
    let grade: unknown = null;
    let nameMatch: boolean | null = null;
    let emailValid: boolean | null = null;
    if (input.firstName || input.lastName) {
      try {
        const name = `${input.firstName} ${input.lastName}`.trim();
        const rc = await this.get(`/2.0/real_contact?phone=${encodeURIComponent(phone)}&name=${encodeURIComponent(name)}`);
        grade = rc?.phone?.contact_grade ?? null;
        nameMatch = rc?.phone?.name_match ?? null;
        emailValid = rc?.email?.is_valid ?? null;
      } catch {
        /* Real Contact may be unavailable on the plan — phone_intel still stands */
      }
    }

    const e164 = this.e164(intel?.phone_number) ?? this.e164(phone) ?? phone;
    const active = intel?.is_valid === true && (intel?.activity_score ?? 0) > 0;
    const gradeConf = this.gradeToConfidence(grade);

    return {
      aliases: [],
      addresses: [],
      phones: [
        {
          number: e164,
          lineType: this.lineType(intel?.line_type),
          carrier: intel?.carrier ?? undefined,
          active,
          // Prepaid + low activity ⇒ higher spam/burner risk.
          spamRisk: intel?.is_prepaid ? 'med' : (intel?.activity_score ?? 100) < 30 ? 'med' : 'low',
          isPrimary: true,
        },
      ],
      emails: [],
      ageRange: null,
      relatives: [],
      associates: [],
      property: { ownership: 'unknown' },
      socialUrls: [], // Trestle returns no social; never fetched
      // Confidence from the contact grade if we got one, else from validity.
      // A confirmed name_match lifts it a notch.
      providerConfidence: Math.min(
        0.98,
        (gradeConf ?? (intel?.is_valid ? 0.65 : 0.3)) + (nameMatch === true ? 0.05 : 0) + (emailValid ? 0.02 : 0),
      ),
      sourceProvider: this.code,
    };
  }
}
