import { Injectable, Logger } from '@nestjs/common';
import { CountryCode, parsePhoneNumberFromString } from 'libphonenumber-js';
import { PrismaService } from '../common/prisma.service';
import {
  EnrichmentDataProvider,
  PersonEnrichment,
} from '../enrichment/enrichment.types';
import { GeoService } from '../enrichment/geo.service';
import { PersonDataProvider, PersonMatch, PersonSearchQuery } from './provider.interface';

/**
 * LeadTrace Engine — our own free-tier provider. Runs entirely on this server,
 * costs $0, and needs no third-party account. It assembles what is derivable
 * WITHOUT buying data or scraping anyone's personal information:
 *
 *  1. Phone intelligence, offline: libphonenumber gives validity, line type
 *     (mobile / landline / voip), country and carrier region — enough to stop
 *     wasted dials before you pay a provider.
 *  2. Geo/address, offline: the bundled ZIP → city/state/timezone and
 *     area-code tables (GeoService). An optional, OFF-BY-DEFAULT hook can call
 *     genuinely-free NON-personal reference APIs (e.g. ZIP lookup); it never
 *     fetches personal data and gracefully no-ops offline.
 *  3. First-party cross-reference: aliases, prior addresses and extra phone
 *     numbers pulled from YOUR OWN past leads and enrichments — legitimately
 *     your data, not harvested from the web.
 *
 * COMPLIANCE: this engine performs NO scraping of third-party personal data,
 * NO social/web-content fetching, and NO photo/biometric processing — the same
 * guardrails enforced project-wide by the static tests. Social data, if any,
 * is only what a real licensed provider would later return, never fetched here.
 */
@Injectable()
export class OwnServerProvider implements PersonDataProvider, EnrichmentDataProvider {
  readonly code = 'LEADTRACE_ENGINE';
  private readonly logger = new Logger(OwnServerProvider.name);
  private readonly region = (process.env.DEFAULT_PHONE_REGION || 'US') as CountryCode;

  constructor(
    private readonly prisma: PrismaService,
    private readonly geo: GeoService,
  ) {}

  // ── Phone metadata, fully offline ──────────────────────────
  private phoneFacts(input: string) {
    const parsed = parsePhoneNumberFromString(input, this.region);
    if (!parsed || !parsed.isValid()) return null;
    const t = parsed.getType();
    const lineType: 'mobile' | 'landline' | 'voip' | 'unknown' =
      t === 'MOBILE'
        ? 'mobile'
        : t === 'FIXED_LINE'
          ? 'landline'
          : t === 'FIXED_LINE_OR_MOBILE'
            ? 'mobile'
            : t === 'VOIP'
              ? 'voip'
              : 'unknown';
    return { e164: parsed.number, country: parsed.country ?? null, lineType };
  }

  // ── First-party lookups against our own database ───────────
  private async firstParty(query: PersonSearchQuery) {
    const where: Record<string, unknown>[] = [];
    if (query.phone) where.push({ phones: { some: { phone: query.phone } } }, { primaryPhone: query.phone });
    if (query.lastName) {
      const nameWhere: Record<string, unknown> = { lastName: { equals: query.lastName, mode: 'insensitive' } };
      if (query.firstName) nameWhere.firstName = { startsWith: query.firstName, mode: 'insensitive' };
      where.push(nameWhere);
    }
    if (!where.length) return [];
    return this.prisma.lead.findMany({
      where: { OR: where },
      include: { phones: true, enrichment: true },
      take: 25,
      orderBy: { updatedAt: 'desc' },
    });
  }

  // ── PersonDataProvider: search ─────────────────────────────
  async searchPerson(query: PersonSearchQuery): Promise<PersonMatch[]> {
    const results: PersonMatch[] = [];

    // A) First-party matches — people already in your system.
    const firstParty = await this.firstParty(query);
    const seenPhones = new Set<string>();
    for (const lead of firstParty) {
      const phones = [
        { number: lead.primaryPhone, lineType: this.phoneFacts(lead.primaryPhone)?.lineType ?? 'unknown', isPrimary: true },
        ...lead.phones
          .filter((p) => p.phone !== lead.primaryPhone)
          .map((p) => ({ number: p.phone, lineType: this.phoneFacts(p.phone)?.lineType ?? 'unknown', isPrimary: false })),
      ];
      phones.forEach((p) => seenPhones.add(p.number));
      const prior = lead.enrichment?.providerData as { aliases?: string[]; relatives?: Array<{ name: string }> } | null;
      results.push({
        firstName: lead.firstName,
        lastName: lead.lastName,
        phones,
        address: lead.address,
        city: lead.city,
        state: lead.state,
        zip: lead.zip,
        ageRange: null,
        relatives: prior?.relatives?.map((r) => r.name) ?? [],
        // High confidence: this is a confirmed record from your own data.
        confidence: 88,
        sourceProvider: this.code,
      });
    }

    // B) Derived record from offline phone + geo facts (when a phone was given
    //    and we had no first-party hit for it) — valid, callable-format lead
    //    skeleton you can start working immediately.
    if (query.phone && !seenPhones.has(query.phone)) {
      const facts = this.phoneFacts(query.phone);
      if (facts) {
        const g = this.geo.enrich({ phone: facts.e164, zip: query.zip ?? null });
        results.push({
          firstName: query.firstName ? this.titleCase(query.firstName) : 'Unknown',
          lastName: query.lastName ? this.titleCase(query.lastName) : 'Contact',
          phones: [{ number: facts.e164, lineType: facts.lineType, isPrimary: true }],
          address: null,
          city: g.city,
          state: g.state,
          zip: query.zip ?? null,
          ageRange: null,
          relatives: [],
          // Lower confidence: derived metadata only, identity unconfirmed.
          confidence: facts.lineType === 'mobile' ? 45 : 35,
          sourceProvider: this.code,
        });
      }
    }

    return results.sort((a, b) => b.confidence - a.confidence).slice(0, 25);
  }

  // ── EnrichmentDataProvider: enrich ─────────────────────────
  async enrichPerson(input: { phone: string; firstName: string; lastName: string; zip?: string | null }): Promise<PersonEnrichment> {
    const facts = this.phoneFacts(input.phone);
    const g = this.geo.enrich({ phone: facts?.e164 ?? input.phone, zip: input.zip ?? null });

    // First-party: everything we already know about this phone/person.
    const known = await this.firstParty({ phone: input.phone, lastName: input.lastName, firstName: input.firstName });
    const aliases = new Set<string>();
    const addresses: PersonEnrichment['addresses'] = [];
    const extraPhones = new Map<string, 'mobile' | 'landline' | 'voip' | 'unknown'>();
    for (const lead of known) {
      if (lead.firstName.toLowerCase() !== input.firstName.toLowerCase()) {
        aliases.add(`${lead.firstName} ${lead.lastName}`);
      }
      if (lead.address && lead.city) {
        addresses.push({
          line1: lead.address,
          city: lead.city,
          state: lead.state ?? '',
          zip: lead.zip ?? '',
          county: g.county ?? undefined,
          type: 'current',
        });
      }
      for (const p of lead.phones) {
        if (p.phone !== input.phone) extraPhones.set(p.phone, this.phoneFacts(p.phone)?.lineType ?? 'unknown');
      }
    }

    const primary = {
      number: facts?.e164 ?? input.phone,
      lineType: facts?.lineType ?? ('unknown' as const),
      carrier: undefined,
      // Offline engine can confirm the number is valid & well-formed, but not
      // live-status — honestly reported: active unknown → treated as true,
      // spamRisk low (no signal). A paid provider fills these in later.
      active: !!facts,
      spamRisk: 'low' as const,
      isPrimary: true,
    };

    return {
      aliases: [...aliases],
      addresses,
      phones: [
        primary,
        ...[...extraPhones].map(([number, lineType]) => ({
          number,
          lineType,
          carrier: undefined,
          active: true,
          spamRisk: 'low' as const,
          isPrimary: false,
        })),
      ],
      emails: [],
      ageRange: null,
      relatives: [],
      associates: [],
      property: { ownership: 'unknown' },
      socialUrls: [], // never fetched or synthesized
      // Confidence reflects that this is offline-derived + first-party only.
      providerConfidence: facts ? (known.length ? 0.75 : 0.5) : 0.2,
      sourceProvider: this.code,
    };
  }

  private titleCase(s: string) {
    return s.charAt(0).toUpperCase() + s.slice(1).toLowerCase();
  }
}
