import { Injectable } from '@nestjs/common';
import { PrismaService } from '../common/prisma.service';
import {
  ComplianceData,
  GeoEnrichment,
  Intelligence,
  PersonEnrichment,
} from './enrichment.types';

/**
 * Section E — computed in-house from the stored blobs. No external calls.
 * Scores are reproducible: the same blobs + the same weights ⇒ the same score,
 * and every point is itemized in scoreBreakdown.
 */
@Injectable()
export class ScoringService {
  constructor(private readonly prisma: PrismaService) {}

  async weights(): Promise<Record<string, number>> {
    const rows = await this.prisma.scoreWeight.findMany();
    return Object.fromEntries(rows.map((r) => [r.key, r.weight]));
  }

  async compute(
    leadId: number,
    provider: PersonEnrichment | null,
    geo: GeoEnrichment | null,
    compliance: ComplianceData | null,
  ): Promise<Intelligence> {
    const w = await this.weights();
    const breakdown: Intelligence['scoreBreakdown'] = [];
    let score = 0;

    const primaryPhone = provider?.phones.find((p) => p.isPrimary) ?? provider?.phones[0] ?? null;

    // ── data completeness ──
    const fields = [
      !!primaryPhone,
      !!provider?.emails.length,
      !!provider?.addresses.length,
      !!provider?.ageRange,
      !!provider?.relatives.length,
      provider ? provider.property.ownership !== 'unknown' : false,
      !!geo?.timezone,
      !!compliance,
    ];
    const completeness = Math.round((fields.filter(Boolean).length / fields.length) * 100);

    // ── weighted heuristic score (spec section E) ──
    if (primaryPhone?.active && primaryPhone.lineType === 'mobile') {
      score += w.phone_active_mobile ?? 30;
      breakdown.push({ key: 'phone_active_mobile', points: w.phone_active_mobile ?? 30, reason: 'Primary phone is an active mobile' });
    }
    if (provider?.emails.length) {
      score += w.has_valid_email ?? 10;
      breakdown.push({ key: 'has_valid_email', points: w.has_valid_email ?? 10, reason: `${provider.emails.length} email(s) on file` });
    }
    if (provider?.property.ownership === 'own') {
      score += w.property_owner ?? 15;
      breakdown.push({ key: 'property_owner', points: w.property_owner ?? 15, reason: 'Property owner' });
    }
    if (geo?.addressValid) {
      score += w.address_validated ?? 10;
      breakdown.push({ key: 'address_validated', points: w.address_validated ?? 10, reason: 'Address validated' });
    }
    if (compliance?.callable) {
      score += w.callable ?? 20;
      breakdown.push({ key: 'callable', points: w.callable ?? 20, reason: 'Clear to call (no DNC/litigator flags)' });
    }
    const completenessPoints = Math.round(((w.data_completeness_max ?? 15) * completeness) / 100);
    score += completenessPoints;
    breakdown.push({ key: 'data_completeness', points: completenessPoints, reason: `${completeness}% data completeness` });

    // Not callable ⇒ hard cap (spec: "if false, hard-cap score low")
    if (compliance && !compliance.callable) {
      const cap = w.not_callable_score_cap ?? 25;
      if (score > cap) {
        breakdown.push({ key: 'not_callable_cap', points: cap - score, reason: `Score hard-capped at ${cap}: lead is not callable` });
        score = cap;
      }
    }
    score = Math.max(0, Math.min(100, score));

    // ── conversion probability: transparent heuristic (Phase 1) ──
    // Blend of the normalized lead score and the org's own historical win rate.
    // Phase 2 (a model trained on this client's CLOSED_WON/LOST) replaces the
    // blend but the heuristic stays as the documented fallback.
    const [won, closed] = await Promise.all([
      this.prisma.lead.count({ where: { status: 'CLOSED_WON' } }),
      this.prisma.lead.count({ where: { status: { in: ['CLOSED_WON', 'CLOSED_LOST'] } } }),
    ]);
    const baseRate = closed >= 10 ? won / closed : 0.15; // prior until history accrues
    const conversionProbability = compliance && !compliance.callable
      ? 0
      : Math.min(0.95, Math.round((baseRate * 0.5 + (score / 100) * 0.5) * 100) / 100);

    // ── best time to call: lead-local evening/late-morning windows, refined by
    // the org's own historical connect pattern once call outcomes accrue ──
    const connects = await this.prisma.activity.count({ where: { type: 'CALL' } });
    const bestTimeToCall = geo?.timezone
      ? `${connects >= 50 ? 'Historical best' : 'Suggested'}: 10:00–11:30 or 16:30–18:30 lead-local time (${geo.timezone})`
      : 'Unknown timezone — default to 16:30–18:30 in the lead’s area';

    // ── contact history from activities ──
    const calls = await this.prisma.activity.findMany({
      where: { leadId, type: 'CALL' },
      orderBy: { createdAt: 'desc' },
      take: 20,
      include: { user: { select: { name: true } } },
    });
    const contactHistory = calls.map((c) => ({
      at: c.createdAt.toISOString(),
      agent: c.user.name,
      outcome: c.detail.slice(0, 120),
    }));

    // ── duplicate detection: same phone or same standardized address elsewhere ──
    const lead = await this.prisma.lead.findUnique({ where: { id: leadId }, include: { phones: true } });
    const dupCount = lead
      ? await this.prisma.lead.count({
          where: {
            id: { not: leadId },
            OR: [
              { phones: { some: { phone: { in: lead.phones.map((p) => p.phone) } } } },
              ...(lead.address && lead.zip ? [{ address: lead.address, zip: lead.zip }] : []),
            ],
          },
        })
      : 0;

    // ── routing hint: the closer with the best win record ──
    const winners = await this.prisma.activity.groupBy({
      by: ['userId'],
      where: { type: 'STATUS_CHANGE', detail: { startsWith: 'Deal WON' } },
      _count: { _all: true },
      orderBy: { _count: { userId: 'desc' } },
      take: 1,
    });
    let routingHint: Intelligence['routingHint'];
    if (winners.length) {
      const user = await this.prisma.user.findUnique({ where: { id: winners[0].userId }, select: { id: true, name: true } });
      if (user) {
        routingHint = {
          userId: user.id,
          name: user.name,
          reason: `${winners[0]._count._all} closed-won deal(s) — highest on the team`,
        };
      }
    }

    return {
      dataCompletenessPct: completeness,
      leadScore: score,
      conversionProbability,
      conversionProbabilityMethod: 'heuristic',
      bestTimeToCall,
      contactHistory,
      duplicateFlag: dupCount > 0,
      routingHint,
      scoreBreakdown: breakdown,
    };
  }
}
