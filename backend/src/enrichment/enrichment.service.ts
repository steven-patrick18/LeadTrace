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
import { OwnServerProvider } from '../providers/own-server.provider';
import {
  ComplianceData,
  DncScrubProvider,
  EnrichmentDataProvider,
  GeoEnrichment,
  PersonEnrichment,
} from './enrichment.types';
import { GeoService } from './geo.service';
import { MockDncProvider } from './mock-dnc.provider';
import { MockEnrichmentProvider } from './mock-enrichment.provider';
import { ScoringService } from './scoring.service';

// DNC data goes stale fast relative to person data — scrub cache is capped at
// 7 days regardless of the (longer) enrichment TTL.
const DNC_CACHE_TTL_HOURS = 168;

@Injectable()
export class EnrichmentService {
  private readonly logger = new Logger(EnrichmentService.name);
  private readonly enrichers: Map<string, EnrichmentDataProvider>;
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
    mockDnc: MockDncProvider,
    engine: OwnServerProvider,
    batchData: BatchDataProvider,
  ) {
    // Registered enrichment adapters; which one runs is DB config
    // (provider_settings.is_active). MOCK for dev, LEADTRACE_ENGINE is our
    // free self-hosted tier; paid adapters (Trestle, Endato, TLO, Twilio
    // Lookup, BatchData) register here as they are implemented.
    this.enrichers = new Map<string, EnrichmentDataProvider>([
      [mockEnricher.code, mockEnricher],
      [engine.code, engine],
      [batchData.code, batchData],
    ]);
    this.scrub = mockDnc; // swap for a real scrub adapter when subscribed
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

    // ── Section A: licensed provider data (paid, cache-first) ──
    try {
      const result = await this.cachedPaidCall<PersonEnrichment>(
        `enrich:phone=${lead.primaryPhone}`,
        ttlHours,
        capCents,
        user.id,
        async () => {
          const active = await this.prisma.providerSetting.findFirst({ where: { isActive: true } });
          const adapter = (active && this.enrichers.get(active.code)) || this.enrichers.get('MOCK')!;
          const data = await adapter.enrichPerson({
            phone: lead.primaryPhone,
            firstName: lead.firstName,
            lastName: lead.lastName,
            zip: lead.zip,
          });
          return { data, costCents: active?.code === adapter.code ? active.costPerSearchCents : 0, providerCode: adapter.code };
        },
      );
      providerData = result.data;
      costCents += result.paidCents;
    } catch (e) {
      failures.push(`provider: ${(e as Error).message}`);
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

    const scrubResult = await this.cachedPaidCall<Awaited<ReturnType<DncScrubProvider['scrub']>>>(
      `dnc:phone=${phone}`,
      Math.min(ttlHours, DNC_CACHE_TTL_HOURS),
      capCents,
      userId,
      async () => ({ data: await this.scrub.scrub(phone), costCents: 0, providerCode: this.scrub.code }),
    );
    const scrub = scrubResult.data;

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
