import {
  BadRequestException,
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { AuditService } from '../common/audit.service';
import { tryToE164 } from '../common/phone.util';
import { PrismaService } from '../common/prisma.service';
import { ProviderRegistry } from '../providers/provider.registry';
import { PersonMatch, PersonSearchQuery } from '../providers/provider.interface';

@Injectable()
export class SearchService {
  private readonly logger = new Logger(SearchService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly registry: ProviderRegistry,
  ) {}

  /**
   * Cache-first person search (spec Phase 2: "cache-first, always").
   * search_key is a normalized (lowercased, sorted) representation so
   * equivalent searches hit the same row (spec §4 invariant 3).
   */
  async searchPerson(rawQuery: PersonSearchQuery, userId: number) {
    const query = this.normalizeQuery(rawQuery);
    const searchKey = this.buildSearchKey(query);

    // Query EVERY active provider with an adapter; each is independently
    // cache-first and cap/limit-gated. Results are merged and deduped by phone,
    // with a match cross-verified by more providers ranked higher.
    const active = await this.prisma.providerSetting.findMany({ where: { isActive: true } });
    const implemented = active.filter((p) => this.registry.get(p.code));
    if (!implemented.length) {
      throw new ServiceUnavailableException('No active data provider — activate one on the Providers page');
    }

    const collected: PersonMatch[] = [];
    const contributors: string[] = []; // providers that returned ≥1 match
    const queried: string[] = []; // every provider we asked
    let anyLive = false;
    const errors: string[] = [];

    for (const provider of implemented) {
      const key = `search:${provider.code.toLowerCase()}:${searchKey}`;
      queried.push(provider.code);
      try {
        const cached = await this.prisma.searchCache.findUnique({ where: { searchKey: key } });
        if (cached && cached.expiresAt > new Date()) {
          await this.recordUsage(provider.id, userId, key, true, 0);
          const rows = cached.response as unknown as PersonMatch[];
          collected.push(...rows);
          if (rows.length) contributors.push(provider.code);
          continue;
        }
        // Spend cap + request limit (paid providers only meaningfully)
        if (provider.dailySpendCapCents > 0) {
          const spent = await this.spentTodayCents(provider.id);
          if (spent + provider.costPerSearchCents > provider.dailySpendCapCents) {
            await this.audit.log({ userId, action: 'PROVIDER_SPEND_CAP_HIT', detail: { provider: provider.code } });
            errors.push(`${provider.code}: spend cap reached`);
            continue;
          }
        }
        if (provider.dailyRequestLimit > 0 && (await this.liveCallsToday(provider.id)) >= provider.dailyRequestLimit) {
          await this.audit.log({ userId, action: 'PROVIDER_REQUEST_LIMIT_HIT', detail: { provider: provider.code } });
          errors.push(`${provider.code}: request limit reached`);
          continue;
        }

        const matches = await this.registry.get(provider.code)!.searchPerson(query);
        anyLive = true;
        const ttlHours = provider.cacheTtlHours || 720;
        const expiresAt = new Date(Date.now() + ttlHours * 3600 * 1000);
        await this.prisma.searchCache.upsert({
          where: { searchKey: key },
          update: { provider: provider.code, response: matches as unknown as Prisma.InputJsonValue, expiresAt, createdAt: new Date() },
          create: { searchKey: key, provider: provider.code, response: matches as unknown as Prisma.InputJsonValue, expiresAt },
        });
        await this.recordUsage(provider.id, userId, key, false, provider.costPerSearchCents);
        collected.push(...matches);
        if (matches.length) contributors.push(provider.code);
      } catch (e) {
        errors.push(`${provider.code}: ${(e as Error).message}`);
      }
    }

    const merged = this.mergeMatches(collected);
    // Identity is present only if some match has a real name (not the engine's
    // "Unknown Contact" phone skeleton). Signals the UI to guide the user.
    const hasIdentity = merged.some((m) => m.firstName && m.firstName !== 'Unknown');
    return {
      matches: merged,
      cacheHit: !anyLive && contributors.length > 0,
      provider: contributors.join('+') || 'none',
      providers: contributors,
      queried,
      hasIdentity,
      errors,
      searchedAt: new Date(),
    };
  }

  /** Dedupe matches across providers by primary phone; cross-verified = higher. */
  private mergeMatches(all: PersonMatch[]): PersonMatch[] {
    const byPhone = new Map<string, PersonMatch & { verifiedBy: number }>();
    const noPhone: PersonMatch[] = [];
    for (const m of all) {
      const primary = m.phones?.find((p) => p.isPrimary)?.number ?? m.phones?.[0]?.number;
      if (!primary) {
        noPhone.push(m);
        continue;
      }
      const cur = byPhone.get(primary);
      if (!cur) {
        byPhone.set(primary, { ...m, verifiedBy: 1 });
      } else {
        cur.verifiedBy += 1;
        // Keep the higher-confidence record; boost for cross-verification.
        if (m.confidence > cur.confidence) Object.assign(cur, m, { verifiedBy: cur.verifiedBy });
      }
    }
    const merged = [...byPhone.values()].map((m) => ({
      ...m,
      confidence: Math.min(99, m.confidence + (m.verifiedBy - 1) * 8), // agreement bonus
      sourceProvider: m.verifiedBy > 1 ? `${m.sourceProvider} +${m.verifiedBy - 1}` : m.sourceProvider,
    }));
    return [...merged, ...noPhone].sort((a, b) => b.confidence - a.confidence).slice(0, 25);
  }

  private normalizeQuery(raw: PersonSearchQuery): PersonSearchQuery {
    const query: PersonSearchQuery = {};
    if (raw.phone?.trim()) {
      const e164 = tryToE164(raw.phone);
      if (!e164) throw new BadRequestException('Enter a valid phone number');
      query.phone = e164;
    }
    if (raw.firstName?.trim()) query.firstName = raw.firstName.trim().toLowerCase();
    if (raw.lastName?.trim()) query.lastName = raw.lastName.trim().toLowerCase();
    if (raw.zip?.trim()) {
      const zip = raw.zip.trim();
      if (!/^\d{5}$/.test(zip)) throw new BadRequestException('ZIP must be 5 digits');
      query.zip = zip;
    }
    if (!query.phone && !query.lastName && !query.zip) {
      throw new BadRequestException('Provide a phone, a last name, or a ZIP to search');
    }
    if (query.firstName && !query.lastName) {
      throw new BadRequestException('First-name search requires a last name');
    }
    return query;
  }

  private buildSearchKey(query: PersonSearchQuery): string {
    return Object.entries(query)
      .filter(([, v]) => v !== undefined)
      .map(([k, v]) => [k.toLowerCase(), String(v).toLowerCase()] as const)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${k}=${v}`)
      .join('&');
  }

  private async activeProvider() {
    const provider = await this.prisma.providerSetting.findFirst({ where: { isActive: true } });
    if (!provider) throw new ServiceUnavailableException('No active data provider configured');
    return provider;
  }

  private async liveCallsToday(providerId: number): Promise<number> {
    const startOfDay = new Date();
    startOfDay.setHours(0, 0, 0, 0);
    return this.prisma.providerUsage.count({
      where: { providerId, createdAt: { gte: startOfDay }, cacheHit: false },
    });
  }

  private async spentTodayCents(providerId: number): Promise<number> {
    const startOfDay = new Date();
    startOfDay.setHours(0, 0, 0, 0);
    const agg = await this.prisma.providerUsage.aggregate({
      where: { providerId, createdAt: { gte: startOfDay }, cacheHit: false },
      _sum: { costCents: true },
    });
    return agg._sum.costCents ?? 0;
  }

  private async recordUsage(
    providerId: number,
    userId: number,
    searchKey: string,
    cacheHit: boolean,
    costCents: number,
  ) {
    await this.prisma.providerUsage.create({
      data: { providerId, userId, searchKey, cacheHit, costCents },
    });
  }
}
