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

    const provider = await this.activeProvider();
    const adapter = this.registry.get(provider.code);
    if (!adapter) {
      throw new ServiceUnavailableException(
        `Provider ${provider.code} is active in settings but has no adapter registered`,
      );
    }

    // 1) Cache
    const cached = await this.prisma.searchCache.findUnique({ where: { searchKey } });
    if (cached && cached.expiresAt > new Date()) {
      await this.recordUsage(provider.id, userId, searchKey, true, 0);
      return {
        matches: cached.response as unknown as PersonMatch[],
        cacheHit: true,
        provider: provider.code,
        searchedAt: cached.createdAt,
      };
    }

    // 2) Spend cap (spec §8 NFR: daily spend cap per provider with alert)
    if (provider.dailySpendCapCents > 0) {
      const spentToday = await this.spentTodayCents(provider.id);
      if (spentToday + provider.costPerSearchCents > provider.dailySpendCapCents) {
        await this.audit.log({
          userId,
          action: 'PROVIDER_SPEND_CAP_HIT',
          detail: { provider: provider.code, spentToday, cap: provider.dailySpendCapCents },
        });
        throw new ServiceUnavailableException(
          `Daily spend cap reached for provider ${provider.displayName}. Try again tomorrow or raise the cap in Settings.`,
        );
      }
    }

    // 2b) API access limit: max live requests per day for this provider
    if (provider.dailyRequestLimit > 0) {
      const callsToday = await this.liveCallsToday(provider.id);
      if (callsToday >= provider.dailyRequestLimit) {
        await this.audit.log({
          userId,
          action: 'PROVIDER_REQUEST_LIMIT_HIT',
          detail: { provider: provider.code, callsToday, limit: provider.dailyRequestLimit },
        });
        throw new ServiceUnavailableException(
          `Daily API request limit reached for ${provider.displayName} (${provider.dailyRequestLimit}/day). Cached results still work.`,
        );
      }
    }

    // 3) Live provider call
    const matches = await adapter.searchPerson(query);

    // 4) Store in cache (upsert handles expired rows being refreshed)
    const ttlHours = provider.cacheTtlHours || 720;
    const expiresAt = new Date(Date.now() + ttlHours * 3600 * 1000);
    await this.prisma.searchCache.upsert({
      where: { searchKey },
      update: { provider: provider.code, response: matches as unknown as Prisma.InputJsonValue, expiresAt, createdAt: new Date() },
      create: { searchKey, provider: provider.code, response: matches as unknown as Prisma.InputJsonValue, expiresAt },
    });
    await this.recordUsage(provider.id, userId, searchKey, false, provider.costPerSearchCents);

    return { matches, cacheHit: false, provider: provider.code, searchedAt: new Date() };
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
