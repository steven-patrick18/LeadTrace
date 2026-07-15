import {
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { AuditService } from '../common/audit.service';
import { AuthUser } from '../common/decorators';
import { PrismaService } from '../common/prisma.service';
import { LeadAccessService } from '../leads/lead-access.service';
import { NotificationsService } from '../notifications/notifications.service';
import { PermissionsService } from '../permissions/permissions.service';
import { BatchDataProvider } from '../providers/batchdata.provider';
import { IpqsProvider } from '../providers/ipqs.provider';
import { MelissaProvider } from '../providers/melissa.provider';
import { NumverifyProvider } from '../providers/numverify.provider';
import { EndatoProvider } from '../providers/endato.provider';
import { SearchBugProvider } from '../providers/searchbug.provider';
import { OwnServerProvider } from '../providers/own-server.provider';
import { TrestleProvider } from '../providers/trestle.provider';
import { TwilioLookupProvider } from '../providers/twilio-lookup.provider';
import {
  ComplianceData,
  DncScrubProvider,
  EnrichmentDataProvider,
  GeoEnrichment,
  IdentityVerification,
  PersonEnrichment,
  ProviderContribution,
} from './enrichment.types';
import { GeoService } from './geo.service';
import { InternalDncProvider } from './internal-dnc.provider';
import { MockEnrichmentProvider } from './mock-enrichment.provider';
import { ScoringService } from './scoring.service';

// DNC data goes stale fast relative to person data — scrub cache is capped at
// 7 days regardless of the (longer) enrichment TTL.
const DNC_CACHE_TTL_HOURS = 168;

@Injectable()
export class EnrichmentService {
  private readonly logger = new Logger(EnrichmentService.name);
  private readonly enrichers: Map<string, EnrichmentDataProvider>;
  private readonly identityVerifier: TwilioLookupProvider; // carrier-authoritative name/address match
  private scrub: DncScrubProvider;

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly geo: GeoService,
    private readonly scoring: ScoringService,
    private readonly permissions: PermissionsService,
    private readonly notifications: NotificationsService,
    private readonly leadAccess: LeadAccessService,
    mockEnricher: MockEnrichmentProvider,
    internalDnc: InternalDncProvider,
    engine: OwnServerProvider,
    batchData: BatchDataProvider,
    trestle: TrestleProvider,
    melissa: MelissaProvider,
    twilio: TwilioLookupProvider,
    ipqs: IpqsProvider,
    numverify: NumverifyProvider,
    endato: EndatoProvider,
    searchbug: SearchBugProvider,
  ) {
    // Registered enrichment adapters; which one runs is DB config
    // (provider_settings.is_active). MOCK for dev, LEADTRACE_ENGINE is our
    // free self-hosted tier; paid adapters (Trestle, Endato, TLO, Twilio
    // Lookup, BatchData) register here as they are implemented.
    this.enrichers = new Map<string, EnrichmentDataProvider>([
      [mockEnricher.code, mockEnricher],
      [engine.code, engine],
      [batchData.code, batchData],
      [trestle.code, trestle],
      [melissa.code, melissa],
      [twilio.code, twilio],
      [ipqs.code, ipqs],
      [numverify.code, numverify],
      [endato.code, endato],
      [searchbug.code, searchbug],
    ]);
    this.identityVerifier = twilio;
    this.scrub = internalDnc; // authoritative: the team's own DNC List page only
  }

  /** POST /leads/:id/enrich — runs A → C → D, then computes E (spec). */
  async enrich(user: AuthUser, leadId: number, ip?: string) {
    const lead = await this.assertLeadAccess(user, leadId);

    const ttlHours = Number((await this.setting('enrichment_cache_ttl_hours')) ?? 720);
    const capCents = Number((await this.setting('enrichment_daily_cap_cents')) ?? 2500);

    let providerData: PersonEnrichment | null = null;
    let geoData: GeoEnrichment | null = null;
    let complianceData: ComplianceData | null = null;
    let costCents = 0;
    const failures: string[] = [];

    // ── Section A: query EVERY active provider, then merge + cross-verify ──
    // Each provider is independently cache-first, spend-capped and
    // request-limited. One provider failing (e.g. no balance) is skipped, not
    // fatal — the others still contribute (PARTIAL). Fields confirmed by 2+
    // providers get a higher accuracy score.
    const input = { phone: lead.primaryPhone, firstName: lead.firstName, lastName: lead.lastName, zip: lead.zip };
    // Cost control: enrich runs providers whose depth level is within THIS
    // user's enrich level. A level-1 user only triggers cheap providers; a
    // level-3 user unlocks the deep (expensive) ones. Set per user on the
    // Users page; set per provider on the Providers page.
    const me = await this.prisma.user.findUnique({ where: { id: user.id }, select: { enrichLevel: true } });
    const userLevel = me?.enrichLevel ?? 1;
    const active = await this.prisma.providerSetting.findMany({
      where: { isActive: true, enrichLevel: { lte: userLevel } },
    });
    const implemented = active.filter((p) => this.enrichers.has(p.code));
    const perProvider: Array<{ code: string; data: PersonEnrichment }> = [];
    for (const p of implemented) {
      try {
        const r = await this.enrichViaProvider(p, this.enrichers.get(p.code)!, input, ttlHours, capCents, user.id);
        perProvider.push({ code: p.code, data: r.data });
        costCents += r.paidCents;
      } catch (e) {
        failures.push(`${p.code}: ${(e as Error).message}`);
      }
    }
    if (!perProvider.length) {
      failures.push(
        implemented.length
          ? 'no active provider returned data'
          : `no data provider available at your enrich level (${userLevel}) — raise the level or lower a provider's level`,
      );
    } else {
      providerData = this.mergeEnrichments(perProvider);
    }

    // ── Section B: identity VERIFICATION (Twilio Identity Match) ──
    // Carrier-authoritative confirmation that the lead's name+address belongs to
    // the phone. Adds no new PII — only a per-field match + 0–100 score — and
    // lifts (or dents) the merged accuracy score. Cache-first + spend-capped.
    if (active.some((p) => p.code === this.identityVerifier.code)) {
      try {
        const v = await this.verifyIdentity(lead, ttlHours, capCents, user.id);
        if (v.data) {
          costCents += v.paidCents;
          providerData = this.attachVerification(providerData, v.data);
        }
      } catch (e) {
        failures.push(`identity_match: ${(e as Error).message}`);
      }
    }

    // ── Section C: free/public geo (always runs, $0) ──
    try {
      geoData = this.geo.enrich({
        zip: lead.zip,
        city: lead.city,
        state: lead.state,
        address: lead.address,
        phone: lead.primaryPhone,
      });
    } catch (e) {
      failures.push(`geo: ${(e as Error).message}`);
    }

    // ── Section D: compliance (in-house table ALWAYS; external scrub cache-first) ──
    try {
      complianceData = await this.buildCompliance(lead.primaryPhone, ttlHours, capCents, user.id);
    } catch (e) {
      failures.push(`compliance: ${(e as Error).message}`);
      // In-house check must still run even if the external scrub failed
      const internal = await this.internalDncStatus(lead.primaryPhone);
      complianceData = {
        nationalDncStatus: 'unknown',
        stateDncStatus: 'unknown',
        internalDncStatus: internal,
        litigatorFlag: false,
        priorConsent: { hasConsent: false },
        // Fail-safe: unknown external status without consent ⇒ not callable
        callable: internal === 'clear' ? false : false,
      };
    }

    // ── Section E: computed in-house (no external calls) ──
    const intelligence = await this.scoring.compute(leadId, providerData, geoData, complianceData);

    const status =
      failures.length === 0 ? 'COMPLETE' : providerData || geoData || complianceData ? 'PARTIAL' : 'FAILED';

    const saved = await this.prisma.leadEnrichment.upsert({
      where: { leadId },
      update: {
        providerData: providerData as unknown as Prisma.InputJsonValue,
        geoData: geoData as unknown as Prisma.InputJsonValue,
        complianceData: complianceData as unknown as Prisma.InputJsonValue,
        intelligence: intelligence as unknown as Prisma.InputJsonValue,
        enrichedAt: new Date(),
        enrichedById: user.id,
        enrichmentCost: costCents / 100,
        status,
      },
      create: {
        leadId,
        providerData: providerData as unknown as Prisma.InputJsonValue,
        geoData: geoData as unknown as Prisma.InputJsonValue,
        complianceData: complianceData as unknown as Prisma.InputJsonValue,
        intelligence: intelligence as unknown as Prisma.InputJsonValue,
        enrichedById: user.id,
        enrichmentCost: costCents / 100,
        status,
      },
    });

    await this.audit.log({
      userId: user.id,
      action: 'LEAD_ENRICHED',
      ip,
      detail: { leadId, status, costCents, failures, leadScore: intelligence.leadScore, callable: complianceData?.callable },
    });

    return this.present(saved);
  }

  /** GET /leads/:id/enrichment */
  async get(user: AuthUser, leadId: number) {
    await this.assertLeadAccess(user, leadId);
    const row = await this.prisma.leadEnrichment.findUnique({ where: { leadId } });
    if (!row) throw new NotFoundException('Lead has not been enriched yet');
    return this.present(row);
  }

  /**
   * The live calling gate. Consulted by the activities controller before a
   * CALL is logged — checks BOTH the enrichment snapshot and the live
   * in-house opt-out table (the authoritative list may have grown since the
   * last enrich).
   */
  async isCallable(leadId: number): Promise<{ callable: boolean; reasons: string[] }> {
    const lead = await this.prisma.lead.findUnique({ where: { id: leadId }, include: { enrichment: true } });
    if (!lead) throw new NotFoundException('Lead not found');
    const reasons: string[] = [];

    if ((await this.internalDncStatus(lead.primaryPhone)) === 'on_list') {
      reasons.push('Phone is on the internal do-not-call/opt-out list');
    }
    const compliance = lead.enrichment?.complianceData as unknown as ComplianceData | null;
    if (compliance && !compliance.callable) {
      if (compliance.litigatorFlag) reasons.push('Flagged on a TCPA litigator list');
      if (compliance.nationalDncStatus === 'on_list') reasons.push('On the National DNC registry (no recorded consent)');
      if (compliance.stateDncStatus === 'on_list') reasons.push('On a state DNC registry (no recorded consent)');
      if (!reasons.length) reasons.push('Compliance scrub marked this lead not callable');
    }
    return { callable: reasons.length === 0, reasons };
  }

  // ─────────────────────────────────────────────────────────────

  private async buildCompliance(
    phone: string,
    ttlHours: number,
    capCents: number,
    userId: number,
  ): Promise<ComplianceData> {
    const internalDncStatus = await this.internalDncStatus(phone);

    // The scrub reads the team's own DNC List (a free, authoritative local
    // lookup) — never cached, so adding/removing a number takes effect at once.
    const scrub = await this.scrub.scrub(phone);

    // No consent ledger yet ⇒ hasConsent=false until one is built. That makes
    // the gate strictly conservative: any DNC listing blocks calling.
    const priorConsent = { hasConsent: false };

    const onAnyDnc =
      internalDncStatus === 'on_list' ||
      scrub.nationalDncStatus === 'on_list' ||
      scrub.stateDncStatus === 'on_list';

    return {
      nationalDncStatus: scrub.nationalDncStatus,
      stateDncStatus: scrub.stateDncStatus,
      internalDncStatus,
      litigatorFlag: scrub.litigatorFlag,
      priorConsent,
      // Spec rule: not callable if on any DNC without consent, or litigator flag.
      callable: !(onAnyDnc && !priorConsent.hasConsent) && !scrub.litigatorFlag,
    };
  }

  private async internalDncStatus(phone: string): Promise<'on_list' | 'clear'> {
    const hit = await this.prisma.dncOptout.findUnique({ where: { phone } });
    return hit ? 'on_list' : 'clear';
  }

  /**
   * Cache-first wrapper for every paid call (spec cost-control): a hit inside
   * TTL costs nothing; a live call checks the daily enrichment cap first,
   * records usage, and pauses paid enrichment on breach.
   */
  private async cachedPaidCall<T>(
    cacheKey: string,
    ttlHours: number,
    capCents: number,
    userId: number,
    live: () => Promise<{ data: T; costCents: number; providerCode: string }>,
  ): Promise<{ data: T; paidCents: number; cacheHit: boolean }> {
    const cached = await this.prisma.searchCache.findUnique({ where: { searchKey: cacheKey } });
    if (cached && cached.expiresAt > new Date()) {
      return { data: cached.response as unknown as T, paidCents: 0, cacheHit: true };
    }

    if (capCents > 0) {
      const spent = await this.enrichmentSpendTodayCents();
      if (spent >= capCents) {
        await this.alertCapBreached(spent, capCents);
        throw new Error(
          `Daily enrichment spend cap reached ($${(capCents / 100).toFixed(2)}). Paid enrichment paused; free geo + in-house scoring still ran.`,
        );
      }
    }

    // Per-provider API request limit (0 = unlimited)
    const activeProvider = await this.prisma.providerSetting.findFirst({ where: { isActive: true } });
    if (activeProvider && activeProvider.dailyRequestLimit > 0) {
      const startOfDay = new Date();
      startOfDay.setHours(0, 0, 0, 0);
      const callsToday = await this.prisma.providerUsage.count({
        where: { providerId: activeProvider.id, createdAt: { gte: startOfDay }, cacheHit: false },
      });
      if (callsToday >= activeProvider.dailyRequestLimit) {
        throw new Error(
          `Daily API request limit reached for ${activeProvider.displayName} (${activeProvider.dailyRequestLimit}/day).`,
        );
      }
    }

    const result = await live();

    await this.prisma.searchCache.upsert({
      where: { searchKey: cacheKey },
      update: {
        provider: result.providerCode,
        response: result.data as unknown as Prisma.InputJsonValue,
        expiresAt: new Date(Date.now() + ttlHours * 3600_000),
        createdAt: new Date(),
      },
      create: {
        searchKey: cacheKey,
        provider: result.providerCode,
        response: result.data as unknown as Prisma.InputJsonValue,
        expiresAt: new Date(Date.now() + ttlHours * 3600_000),
      },
    });

    const providerRow = await this.prisma.providerSetting.findUnique({ where: { code: result.providerCode } });
    if (providerRow) {
      await this.prisma.providerUsage.create({
        data: {
          providerId: providerRow.id,
          userId,
          searchKey: cacheKey,
          cacheHit: false,
          costCents: result.costCents,
        },
      });
    }
    return { data: result.data, paidCents: result.costCents, cacheHit: false };
  }

  /**
   * One provider's enrichment: cache-first (keyed per provider), global spend
   * cap + this provider's own daily request limit, records usage at this
   * provider's cost. Throws on cap/limit/adapter error (caller skips it).
   */
  private async enrichViaProvider(
    provider: { id: number; code: string; displayName: string; costPerSearchCents: number; dailyRequestLimit: number },
    adapter: EnrichmentDataProvider,
    input: { phone: string; firstName: string; lastName: string; zip?: string | null },
    ttlHours: number,
    capCents: number,
    userId: number,
  ): Promise<{ data: PersonEnrichment; paidCents: number }> {
    const cacheKey = `enrich:${provider.code.toLowerCase()}:phone=${input.phone}`;
    const cached = await this.prisma.searchCache.findUnique({ where: { searchKey: cacheKey } });
    if (cached && cached.expiresAt > new Date()) {
      await this.prisma.providerUsage.create({
        data: { providerId: provider.id, userId, searchKey: cacheKey, cacheHit: true, costCents: 0 },
      });
      return { data: cached.response as unknown as PersonEnrichment, paidCents: 0 };
    }

    // Paid providers respect the global daily spend cap + their own request limit.
    if (provider.costPerSearchCents > 0 && capCents > 0) {
      const spent = await this.enrichmentSpendTodayCents();
      if (spent >= capCents) {
        await this.alertCapBreached(spent, capCents);
        throw new Error(`daily enrichment spend cap reached ($${(capCents / 100).toFixed(2)})`);
      }
    }
    if (provider.dailyRequestLimit > 0) {
      const startOfDay = new Date();
      startOfDay.setHours(0, 0, 0, 0);
      const callsToday = await this.prisma.providerUsage.count({
        where: { providerId: provider.id, createdAt: { gte: startOfDay }, cacheHit: false },
      });
      if (callsToday >= provider.dailyRequestLimit) {
        throw new Error(`daily API request limit reached (${provider.dailyRequestLimit}/day)`);
      }
    }

    const data = await adapter.enrichPerson(input);
    await this.prisma.searchCache.upsert({
      where: { searchKey: cacheKey },
      update: {
        provider: provider.code,
        response: data as unknown as Prisma.InputJsonValue,
        expiresAt: new Date(Date.now() + ttlHours * 3600_000),
        createdAt: new Date(),
      },
      create: {
        searchKey: cacheKey,
        provider: provider.code,
        response: data as unknown as Prisma.InputJsonValue,
        expiresAt: new Date(Date.now() + ttlHours * 3600_000),
      },
    });
    await this.prisma.providerUsage.create({
      data: { providerId: provider.id, userId, searchKey: cacheKey, cacheHit: false, costCents: provider.costPerSearchCents },
    });
    return { data, paidCents: provider.costPerSearchCents };
  }

  /**
   * Run Twilio Identity Match on the lead's name + best-known address, cache-first
   * and spend-capped. Verifies the phone belongs to the claimed person against
   * carrier records. SSN is never submitted (see the provider). Returns null data
   * when there is nothing to verify or the account lacks the package.
   */
  private async verifyIdentity(
    lead: { primaryPhone: string; firstName: string; lastName: string; address: string | null; city: string | null; state: string | null; zip: string | null },
    ttlHours: number,
    capCents: number,
    userId: number,
  ): Promise<{ data: IdentityVerification | null; paidCents: number }> {
    const provider = await this.prisma.providerSetting.findUnique({ where: { code: this.identityVerifier.code } });
    const cost = provider?.costPerSearchCents ?? 0;
    const key = `idmatch:phone=${lead.primaryPhone}:name=${`${lead.firstName} ${lead.lastName}`.trim().toLowerCase()}:zip=${lead.zip ?? ''}`;
    const res = await this.cachedPaidCall<IdentityVerification | null>(key, ttlHours, capCents, userId, async () => ({
      data: await this.identityVerifier.verifyIdentity({
        phone: lead.primaryPhone,
        firstName: lead.firstName,
        lastName: lead.lastName,
        addressLine1: lead.address,
        city: lead.city,
        state: lead.state,
        postalCode: lead.zip,
      }),
      costCents: cost,
      providerCode: this.identityVerifier.code,
    }));
    return { data: res.data, paidCents: res.cacheHit ? 0 : res.paidCents };
  }

  /**
   * Fold a verification result into the merged record and adjust its accuracy:
   * a strong carrier match (score ≥ 80) nudges accuracy up, a clear no-match
   * (≤ 20) nudges it down — the phone/person link is independently corroborated.
   */
  private attachVerification(base: PersonEnrichment | null, v: IdentityVerification): PersonEnrichment {
    const data: PersonEnrichment =
      base ?? {
        aliases: [],
        addresses: [],
        phones: [],
        emails: [],
        ageRange: null,
        relatives: [],
        associates: [],
        property: { ownership: 'unknown' },
        socialUrls: [],
        providerConfidence: v.summaryScore / 100,
        sourceProvider: v.source,
        sources: [v.source],
      };
    data.identityVerification = v;
    if (typeof data.accuracyScore === 'number') {
      const delta = v.summaryScore >= 80 ? 8 : v.summaryScore >= 70 ? 4 : v.summaryScore <= 20 ? -12 : 0;
      data.accuracyScore = Math.max(5, Math.min(99, data.accuracyScore + delta));
    } else {
      data.accuracyScore = Math.round((base?.providerConfidence ?? v.summaryScore / 100) * 100);
    }
    return data;
  }

  /**
   * Merge several providers' enrichments into one record and score its accuracy.
   * "Best probability of accuracy" = agreement: a phone/email reported by more
   * providers is more trustworthy. Every field is unioned; conflicts prefer the
   * more informative value; the score rises with sources + agreement.
   */
  /** Compact per-provider summary — what each provider returned + its score. */
  private contributionOf(code: string, d: PersonEnrichment): ProviderContribution {
    const first = d.addresses[0];
    return {
      code,
      confidence: Math.round(d.providerConfidence * 100),
      name: d.aliases[0] ?? null,
      topAddress: first ? [first.line1, first.city, first.state, first.zip].filter(Boolean).join(', ') : null,
      counts: {
        phones: d.phones.length,
        addresses: d.addresses.length,
        emails: d.emails.length,
        relatives: d.relatives.length,
      },
    };
  }

  private mergeEnrichments(results: Array<{ code: string; data: PersonEnrichment }>): PersonEnrichment {
    const sources = results.map((r) => r.code);
    const contributors = results.map((r) => this.contributionOf(r.code, r.data));
    if (results.length === 1) {
      const only = results[0].data;
      return { ...only, sources, contributors, accuracyScore: Math.round(only.providerConfidence * 100) };
    }

    // Phones — union by E.164, count how many providers reported each.
    const phoneMap = new Map<string, PersonEnrichment['phones'][number] & { verifiedBy: number }>();
    for (const { data } of results) {
      for (const ph of data.phones) {
        const cur = phoneMap.get(ph.number);
        if (!cur) {
          phoneMap.set(ph.number, { ...ph, verifiedBy: 1 });
        } else {
          cur.verifiedBy += 1;
          if (cur.lineType === 'unknown' && ph.lineType !== 'unknown') cur.lineType = ph.lineType;
          if (!cur.carrier && ph.carrier) cur.carrier = ph.carrier;
          if (ph.active) cur.active = true;
          if (ph.spamRisk === 'high') cur.spamRisk = 'high';
          if (ph.isPrimary) cur.isPrimary = true;
        }
      }
    }
    const phones = [...phoneMap.values()].sort(
      (a, b) => Number(b.isPrimary) - Number(a.isPrimary) || b.verifiedBy - a.verifiedBy,
    );

    const uniq = (arr: string[]) => [...new Set(arr.map((s) => s.trim()).filter(Boolean))];
    const emails = uniq(results.flatMap((r) => r.data.emails.map((e) => e.toLowerCase())));

    const addrKey = (a: PersonEnrichment['addresses'][number]) => `${a.line1}|${a.zip}`.toLowerCase();
    const addrMap = new Map<string, PersonEnrichment['addresses'][number]>();
    for (const { data } of results) for (const a of data.addresses) if (!addrMap.has(addrKey(a))) addrMap.set(addrKey(a), a);

    const nameUniq = <T extends { name: string }>(arr: T[]) => {
      const m = new Map<string, T>();
      for (const x of arr) if (x.name && !m.has(x.name.toLowerCase())) m.set(x.name.toLowerCase(), x);
      return [...m.values()];
    };

    // Prefer the most confident source for scalar fields.
    const best = [...results].sort((a, b) => b.data.providerConfidence - a.data.providerConfidence)[0].data;
    const property = results.map((r) => r.data.property).find((p) => p.ownership !== 'unknown') ?? best.property;

    // Accuracy: average confidence (80%) + agreement bonus for cross-verified
    // phones and multiple sources (up to +20).
    const avgConf = results.reduce((s, r) => s + r.data.providerConfidence, 0) / results.length;
    const verifiedPhones = phones.filter((p) => p.verifiedBy >= 2).length;
    const agreementBonus = Math.min(20, verifiedPhones * 8 + (sources.length - 1) * 5);
    const accuracyScore = Math.max(5, Math.min(99, Math.round(avgConf * 100 * 0.8 + agreementBonus)));

    return {
      aliases: uniq(results.flatMap((r) => r.data.aliases)),
      addresses: [...addrMap.values()],
      phones,
      emails,
      ageRange: best.ageRange,
      relatives: nameUniq(results.flatMap((r) => r.data.relatives)),
      associates: nameUniq(results.flatMap((r) => r.data.associates)),
      property,
      socialUrls: uniq(results.flatMap((r) => r.data.socialUrls)),
      providerConfidence: avgConf,
      sourceProvider: sources.join('+'),
      sources,
      contributors,
      accuracyScore,
    };
  }

  private async enrichmentSpendTodayCents(): Promise<number> {
    const startOfDay = new Date();
    startOfDay.setHours(0, 0, 0, 0);
    const agg = await this.prisma.providerUsage.aggregate({
      where: {
        createdAt: { gte: startOfDay },
        cacheHit: false,
        OR: [{ searchKey: { startsWith: 'enrich:' } }, { searchKey: { startsWith: 'dnc:' } }],
      },
      _sum: { costCents: true },
    });
    return agg._sum.costCents ?? 0;
  }

  private async alertCapBreached(spent: number, cap: number) {
    const admins = await this.permissions.usersWithPermission('view_enrichment_cost');
    await this.notifications.notify(
      admins.map((a) => a.id),
      {
        type: 'ENRICHMENT_CAP',
        title: `Enrichment daily spend cap hit ($${(spent / 100).toFixed(2)} of $${(cap / 100).toFixed(2)}) — paid enrichment paused until midnight`,
      },
    );
  }

  private async assertLeadAccess(user: AuthUser, leadId: number) {
    const lead = await this.prisma.lead.findUnique({ where: { id: leadId } });
    if (!lead) throw new NotFoundException('Lead not found');
    if (await this.leadAccess.isBlocked(user.id, leadId, user.roleId)) {
      throw new ForbiddenException('Your access to this lead has been revoked by an admin');
    }
    const canViewAll = (await this.permissions.check(user.roleId, 'view_all_leads')).allowed;
    if (!canViewAll && lead.assignedToId !== user.id && lead.createdById !== user.id) {
      throw new ForbiddenException('You can only enrich/view your own leads');
    }
    return lead;
  }

  private async setting(key: string): Promise<string | null> {
    return (await this.prisma.appSetting.findUnique({ where: { key } }))?.value ?? null;
  }

  /** localTimeNow is derived here, at display time — never stored (spec §C). */
  private present(row: {
    leadId: number;
    providerData: unknown;
    geoData: unknown;
    complianceData: unknown;
    intelligence: unknown;
    enrichedAt: Date;
    enrichmentCost: unknown;
    status: string;
  }) {
    const geo = row.geoData as GeoEnrichment | null;
    return {
      leadId: row.leadId,
      providerData: row.providerData,
      geoData: geo ? { ...geo, localTimeNow: this.geo.localTimeNow(geo.timezone) } : null,
      complianceData: row.complianceData,
      intelligence: row.intelligence,
      enrichedAt: row.enrichedAt,
      enrichmentCost: Number(row.enrichmentCost),
      status: row.status,
    };
  }
}
