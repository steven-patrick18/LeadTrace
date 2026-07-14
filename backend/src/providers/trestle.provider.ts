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

  /** Reverse Phone (/3.2/phone) → owners with identity. Returns null when the
   *  product is locked/unavailable on the plan (self-serve "Request Access"),
   *  so callers fall back to phone quality. */
  private async reversePhone(phone: string): Promise<any | null> {
    try {
      return await this.get(`/3.2/phone?phone=${encodeURIComponent(phone)}`);
    } catch (e) {
      // 403 / invalid-key here means the Reverse Phone product isn't enabled.
      this.logger.debug(`Trestle Reverse Phone unavailable: ${(e as Error).message}`);
      return null;
    }
  }

  private ownerName(owner: any): { first: string; last: string } {
    if (owner?.firstname || owner?.lastname) return { first: owner.firstname ?? '', last: owner.lastname ?? '' };
    const full = String(owner?.name ?? owner?.names?.[0]?.name ?? '').trim();
    const parts = full.split(/\s+/);
    return { first: parts[0] ?? '', last: parts.slice(1).join(' ') };
  }

  private ownerAddresses(owner: any): PersonEnrichment['addresses'] {
    const all = [...(owner?.current_addresses ?? []), ...(owner?.historical_addresses ?? [])];
    return all
      .filter((a: any) => a?.street_line_1 || a?.line1)
      .map((a: any, i: number) => ({
        line1: a.street_line_1 ?? a.line1,
        city: a.city ?? '',
        state: a.state_code ?? a.state ?? '',
        zip: a.postal_code ?? a.zip ?? '',
        type: i === 0 ? 'current' : 'past',
      }));
  }

  /** Search a phone → its owners (real identity) when Reverse Phone is enabled;
   *  otherwise nothing (the free engine still returns a phone skeleton). */
  async searchPerson(query: PersonSearchQuery): Promise<PersonMatch[]> {
    if (!query.phone) return [];
    const j = await this.reversePhone(query.phone);
    if (!j) return [];
    const primary = this.e164(j?.phone_number) ?? query.phone;
    return (j?.owners ?? []).map((owner: any) => {
      const { first, last } = this.ownerName(owner);
      const addr = (owner?.current_addresses ?? [])[0] ?? {};
      const phones: PersonMatch['phones'] = [{ number: primary, lineType: this.lineType(j?.line_type), isPrimary: true }];
      for (const p of owner?.phones ?? []) {
        const n = this.e164(p?.phone_number ?? p);
        if (n && !phones.some((x) => x.number === n)) phones.push({ number: n, lineType: this.lineType(p?.line_type), isPrimary: false });
      }
      return {
        firstName: first,
        lastName: last,
        phones,
        address: addr?.street_line_1 ?? null,
        city: addr?.city ?? null,
        state: addr?.state_code ?? addr?.state ?? null,
        zip: addr?.postal_code ?? null,
        ageRange: owner?.age_range ?? null,
        relatives: (owner?.associated_people ?? []).map((r: any) => r?.name ?? this.ownerName(r).first).filter(Boolean),
        confidence: 85,
        sourceProvider: this.code,
      } as PersonMatch;
    });
  }

  async enrichPerson(input: { phone: string; firstName: string; lastName: string; zip?: string | null }): Promise<PersonEnrichment> {
    const phone = input.phone.replace(/\s/g, '');

    // Phone quality (always available on self-serve).
    const intel = await this.get(`/3.0/phone_intel?phone=${encodeURIComponent(phone)}`);
    // Identity, when Reverse Phone is enabled (null if locked).
    const reverse = await this.reversePhone(phone);
    const owner = (reverse?.owners ?? [])[0] ?? null;

    // Real Contact adds a contact grade + name-match when we have a name.
    let grade: unknown = null;
    let nameMatch: boolean | null = null;
    if (input.firstName || input.lastName) {
      try {
        const name = `${input.firstName} ${input.lastName}`.trim();
        const rc = await this.get(`/2.0/real_contact?phone=${encodeURIComponent(phone)}&name=${encodeURIComponent(name)}`);
        grade = rc?.phone?.contact_grade ?? null;
        nameMatch = rc?.phone?.name_match ?? null;
      } catch {
        /* Real Contact may be unavailable on the plan */
      }
    }

    const e164 = this.e164(intel?.phone_number) ?? this.e164(phone) ?? phone;
    const active = intel?.is_valid === true && (intel?.activity_score ?? 0) > 0;
    const gradeConf = this.gradeToConfidence(grade);

    const phones: PersonEnrichment['phones'] = [
      {
        number: e164,
        lineType: this.lineType(intel?.line_type),
        carrier: intel?.carrier ?? undefined,
        active,
        spamRisk: intel?.is_prepaid ? 'med' : (intel?.activity_score ?? 100) < 30 ? 'med' : 'low',
        isPrimary: true,
      },
    ];
    for (const p of owner?.phones ?? []) {
      const n = this.e164(p?.phone_number ?? p);
      if (n && !phones.some((x) => x.number === n)) {
        phones.push({ number: n, lineType: this.lineType(p?.line_type), active: true, spamRisk: 'low', isPrimary: false });
      }
    }

    return {
      aliases: (owner?.alternate_names ?? []).map((a: any) => (typeof a === 'string' ? a : `${a?.firstname ?? ''} ${a?.lastname ?? ''}`.trim())).filter(Boolean),
      addresses: owner ? this.ownerAddresses(owner) : [],
      phones,
      emails: (owner?.emails ?? []).map((em: any) => (typeof em === 'string' ? em : em?.email_address ?? em?.email)).filter((em: any) => typeof em === 'string' && em.includes('@')),
      ageRange: owner?.age_range ?? null,
      relatives: (owner?.associated_people ?? []).map((r: any) => ({ name: r?.name ?? this.ownerName(r).first })).filter((r: any) => r.name),
      associates: [],
      property: { ownership: 'unknown' },
      socialUrls: [], // Trestle returns no social; never fetched
      providerConfidence: Math.min(
        0.98,
        (owner ? 0.85 : gradeConf ?? (intel?.is_valid ? 0.65 : 0.3)) + (nameMatch === true ? 0.05 : 0),
      ),
      sourceProvider: this.code,
    };
  }
}
