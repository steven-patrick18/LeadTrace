import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../common/prisma.service';

/**
 * Reports (spec Phase 4). Team-wide vs own-only is decided by the caller's
 * permissions (view_reports_team / view_reports_own) — resolved from the
 * matrix by the controller, never hard-coded to roles.
 */
@Injectable()
export class ReportsService {
  constructor(private readonly prisma: PrismaService) {}

  /** Leads by tier/status + funnel + aging. userId=null → team-wide. */
  async dashboard(userId: number | null) {
    const leadFilter: Prisma.LeadWhereInput = userId
      ? { OR: [{ assignedToId: userId }, { createdById: userId }] }
      : {};

    const byStatus = await this.prisma.lead.groupBy({
      by: ['status'],
      where: leadFilter,
      _count: { _all: true },
    });
    const byTier = await this.prisma.lead.groupBy({
      by: ['currentTier', 'status'],
      where: leadFilter,
      _count: { _all: true },
    });

    // Conversion funnel (spec §5): created → reached SS → reached Closer → won,
    // read from routing_history + closes.
    const funnelFilter: Prisma.LeadWhereInput = userId ? { createdById: userId } : {};
    const [created, reachedSS, reachedCloser, won] = await Promise.all([
      this.prisma.lead.count({ where: funnelFilter }),
      this.prisma.lead.count({
        where: { ...funnelFilter, routingHistory: { some: { transferPoint: 'T1_TO_SS' } } },
      }),
      this.prisma.lead.count({
        where: { ...funnelFilter, routingHistory: { some: { transferPoint: 'T2_TO_CLOSER' } } },
      }),
      this.prisma.lead.count({ where: { ...funnelFilter, status: 'CLOSED_WON' } }),
    ]);

    // Queue aging (team-wide only; own-scope callers see their raised rows)
    const pendingRows = await this.prisma.routingQueue.findMany({
      where: { status: 'PENDING', ...(userId ? { raisedById: userId } : {}) },
      select: { createdAt: true, transferPoint: true },
    });
    const now = Date.now();
    const waits = pendingRows.map((r) => (now - r.createdAt.getTime()) / 60000);

    return {
      scope: userId ? 'own' : 'team',
      byStatus: Object.fromEntries(byStatus.map((r) => [r.status, r._count._all])),
      byTier,
      funnel: { created, reachedSS, reachedCloser, won },
      queue: {
        pending: pendingRows.length,
        avgWaitMinutes: waits.length ? Math.round(waits.reduce((a, b) => a + b, 0) / waits.length) : 0,
        maxWaitMinutes: waits.length ? Math.round(Math.max(...waits)) : 0,
      },
    };
  }

  /** Per-user performance. userId=null → all users (team scope). */
  async performance(userId: number | null) {
    const users = await this.prisma.user.findMany({
      where: { isActive: true, ...(userId ? { id: userId } : {}) },
      select: { id: true, name: true, role: { select: { roleCode: true, displayName: true } } },
    });
    const rows = [];
    for (const u of users) {
      const [createdCount, activeAssigned, callsLogged, transfersRaised, routedOn, closedWon, closedLost] =
        await Promise.all([
          this.prisma.lead.count({ where: { createdById: u.id } }),
          this.prisma.lead.count({
            where: { assignedToId: u.id, status: { in: ['NEW', 'IN_PROGRESS', 'PENDING_ROUTING'] } },
          }),
          this.prisma.activity.count({ where: { userId: u.id, type: 'CALL' } }),
          this.prisma.routingQueue.count({ where: { raisedById: u.id } }),
          this.prisma.routingHistory.count({ where: { toUserId: u.id } }),
          this.prisma.activity.count({
            where: { userId: u.id, type: 'STATUS_CHANGE', detail: { startsWith: 'Deal WON' } },
          }),
          this.prisma.activity.count({
            where: { userId: u.id, type: 'STATUS_CHANGE', detail: { startsWith: 'Deal lost' } },
          }),
        ]);
      rows.push({
        user: u,
        createdCount,
        activeAssigned,
        callsLogged,
        transfersRaised,
        leadsReceived: routedOn,
        closedWon,
        closedLost,
      });
    }
    return rows;
  }

  /** Provider usage & cost (spec Phase 4, gated by view_api_costs). */
  async apiCosts(days: number) {
    const since = new Date(Date.now() - days * 86400_000);
    const providers = await this.prisma.providerSetting.findMany();
    const report = [];
    for (const p of providers) {
      const [liveCalls, cacheHits, cost] = await Promise.all([
        this.prisma.providerUsage.count({
          where: { providerId: p.id, cacheHit: false, createdAt: { gte: since } },
        }),
        this.prisma.providerUsage.count({
          where: { providerId: p.id, cacheHit: true, createdAt: { gte: since } },
        }),
        this.prisma.providerUsage.aggregate({
          where: { providerId: p.id, cacheHit: false, createdAt: { gte: since } },
          _sum: { costCents: true },
        }),
      ]);
      report.push({
        provider: { code: p.code, displayName: p.displayName, isActive: p.isActive },
        liveCalls,
        cacheHits,
        cacheHitRate: liveCalls + cacheHits > 0 ? Math.round((cacheHits / (liveCalls + cacheHits)) * 100) : 0,
        totalCostCents: cost._sum.costCents ?? 0,
        dailySpendCapCents: p.dailySpendCapCents,
      });
    }
    return { sinceDays: days, providers: report };
  }

  /**
   * The Reports & Analysis page (view_reports_team): everything an admin or
   * manager needs to review a period — funnel, outcomes, per-user numbers,
   * daily activity volume, and queue timing — for a chosen day range.
   */
  async analysis(days: number) {
    const since = new Date(Date.now() - days * 86400_000);

    const [createdInPeriod, wonInPeriod, lostInPeriod, byStatus, byTier, funnel, perUser, activities, routed] =
      await Promise.all([
        this.prisma.lead.count({ where: { createdAt: { gte: since } } }),
        this.prisma.lead.count({ where: { status: 'CLOSED_WON', updatedAt: { gte: since } } }),
        this.prisma.lead.count({ where: { status: 'CLOSED_LOST', updatedAt: { gte: since } } }),
        this.prisma.lead.groupBy({ by: ['status'], _count: { _all: true } }),
        this.prisma.lead.groupBy({ by: ['currentTier'], where: { status: { notIn: ['CLOSED_WON', 'CLOSED_LOST', 'INVALID'] } }, _count: { _all: true } }),
        this.dashboard(null).then((d) => d.funnel),
        this.performance(null),
        this.prisma.activity.findMany({
          where: { createdAt: { gte: since } },
          select: { type: true, createdAt: true },
        }),
        this.prisma.routingQueue.findMany({
          where: { status: 'ROUTED', routedAt: { gte: since } },
          select: { createdAt: true, routedAt: true, transferPoint: true },
        }),
      ]);

    // Activity volume per day (calls vs other touches)
    const byDay: Record<string, { calls: number; other: number }> = {};
    for (const a of activities) {
      const day = a.createdAt.toISOString().slice(0, 10);
      byDay[day] ??= { calls: 0, other: 0 };
      if (a.type === 'CALL') byDay[day].calls++;
      else byDay[day].other++;
    }

    // Average time a lead waited in the queue before the admin routed it
    const waits = routed.map((r) => (r.routedAt!.getTime() - r.createdAt.getTime()) / 60000);
    const avgRoutingMinutes = waits.length ? Math.round(waits.reduce((a, b) => a + b, 0) / waits.length) : 0;

    const closed = wonInPeriod + lostInPeriod;
    return {
      sinceDays: days,
      summary: {
        createdInPeriod,
        wonInPeriod,
        lostInPeriod,
        winRatePct: closed ? Math.round((wonInPeriod / closed) * 100) : 0,
        routingDecisions: routed.length,
        avgRoutingMinutes,
        callsInPeriod: activities.filter((a) => a.type === 'CALL').length,
      },
      funnel,
      byStatus: Object.fromEntries(byStatus.map((r) => [r.status, r._count._all])),
      openByTier: Object.fromEntries(byTier.map((r) => [r.currentTier, r._count._all])),
      perUser,
      activityByDay: Object.entries(byDay)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([day, counts]) => ({ day, ...counts })),
    };
  }

  /** CSV of per-user performance (gated by export_data). */
  async exportPerformanceCsv(): Promise<string> {
    const rows = await this.performance(null);
    const header = 'user,role,created,active_assigned,calls,transfers_raised,leads_received,won,lost';
    const lines = rows.map((r) =>
      [r.user.name, r.user.role.displayName, r.createdCount, r.activeAssigned, r.callsLogged,
        r.transfersRaised, r.leadsReceived, r.closedWon, r.closedLost]
        .map((v) => (/[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : v))
        .join(','),
    );
    return [header, ...lines].join('\n');
  }

  /** Enrichment spend (gated by view_enrichment_cost). */
  async enrichmentCosts(days: number) {
    const since = new Date(Date.now() - days * 86400_000);
    const [runs, byStatus, paidCalls, cacheHits, spend, capSetting] = await Promise.all([
      this.prisma.leadEnrichment.count({ where: { enrichedAt: { gte: since } } }),
      this.prisma.leadEnrichment.groupBy({ by: ['status'], _count: { _all: true } }),
      this.prisma.providerUsage.count({
        where: { createdAt: { gte: since }, cacheHit: false, OR: [{ searchKey: { startsWith: 'enrich:' } }, { searchKey: { startsWith: 'dnc:' } }] },
      }),
      this.prisma.providerUsage.count({
        where: { createdAt: { gte: since }, cacheHit: true, OR: [{ searchKey: { startsWith: 'enrich:' } }, { searchKey: { startsWith: 'dnc:' } }] },
      }),
      this.prisma.providerUsage.aggregate({
        where: { createdAt: { gte: since }, cacheHit: false, OR: [{ searchKey: { startsWith: 'enrich:' } }, { searchKey: { startsWith: 'dnc:' } }] },
        _sum: { costCents: true },
      }),
      this.prisma.appSetting.findUnique({ where: { key: 'enrichment_daily_cap_cents' } }),
    ]);
    return {
      sinceDays: days,
      enrichmentRuns: runs,
      byStatus: Object.fromEntries(byStatus.map((r) => [r.status, r._count._all])),
      paidCalls,
      cacheHits,
      totalCostCents: spend._sum.costCents ?? 0,
      dailyCapCents: Number(capSetting?.value ?? 0),
    };
  }

  /** CSV export of leads (gated by export_data). */
  async exportLeadsCsv(): Promise<string> {
    const leads = await this.prisma.lead.findMany({
      orderBy: { id: 'asc' },
      include: {
        assignedTo: { select: { name: true } },
        createdBy: { select: { name: true } },
      },
    });
    const esc = (v: unknown) => {
      const s = v === null || v === undefined ? '' : String(v);
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const header = [
      'id', 'first_name', 'last_name', 'primary_phone', 'city', 'state', 'zip',
      'tier', 'status', 'source_provider', 'created_by', 'assigned_to', 'created_at', 'updated_at',
    ].join(',');
    const rows = leads.map((l) =>
      [
        l.id, l.firstName, l.lastName, l.primaryPhone, l.city, l.state, l.zip,
        l.currentTier, l.status, l.sourceProvider, l.createdBy.name, l.assignedTo?.name,
        l.createdAt.toISOString(), l.updatedAt.toISOString(),
      ].map(esc).join(','),
    );
    return [header, ...rows].join('\n');
  }
}
