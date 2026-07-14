import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Get,
  Ip,
  Param,
  ParseIntPipe,
  Patch,
  Post,
} from '@nestjs/common';
import { ProviderSetting } from '@prisma/client';
import {
  IsBoolean,
  IsInt,
  IsOptional,
  IsString,
  IsUrl,
  Matches,
  Min,
  MinLength,
} from 'class-validator';
import { AuditService } from '../common/audit.service';
import { AuthUser, CurrentUser, RequirePermission } from '../common/decorators';
import { PrismaService } from '../common/prisma.service';
import { ProviderRegistry } from './provider.registry';

class CreateProviderDto {
  @IsString()
  @Matches(/^[A-Z][A-Z0-9_]{1,29}$/, { message: 'code must be UPPER_SNAKE (e.g. MY_PROVIDER)' })
  code!: string;

  @IsString() @MinLength(2) displayName!: string;
  @IsOptional() @IsString() description?: string;
  @IsOptional() @IsUrl() websiteUrl?: string;
  @IsOptional() @IsUrl() signupUrl?: string;
  @IsOptional() @IsUrl() docsUrl?: string;
  @IsOptional() @IsString() howToGet?: string;
}

class UpdateProviderDto {
  @IsOptional() @IsBoolean() isActive?: boolean;
  @IsOptional() @IsInt() @Min(0) costPerSearchCents?: number;
  @IsOptional() @IsInt() @Min(0) dailySpendCapCents?: number;
  @IsOptional() @IsInt() @Min(0) dailyRequestLimit?: number;
  @IsOptional() @IsInt() @Min(1) cacheTtlHours?: number;
  @IsOptional() @IsString() description?: string;
  @IsOptional() @IsUrl() websiteUrl?: string;
  @IsOptional() @IsUrl() signupUrl?: string;
  @IsOptional() @IsUrl() docsUrl?: string;
  @IsOptional() @IsString() howToGet?: string;
  @IsOptional() @IsString() baseUrl?: string;
  /** Write-only: keys are stored server-side and never returned (spec §8 NFR). */
  @IsOptional() @IsString() @MinLength(4) apiKey?: string;
  @IsOptional() @IsString() @MinLength(4) apiSecret?: string;
  /** Permitted-use attestation (spec §8): sales lead-gen only, never FCRA/DPPA/GLBA uses. */
  @IsOptional() @IsString() @MinLength(20) permittedUseAttestation?: string;
}

@Controller('providers')
export class ProvidersController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly registry: ProviderRegistry,
  ) {}

  /** Sanitized view: credentials NEVER leave the server — only presence + last 4. */
  private sanitize(p: ProviderSetting) {
    const { apiKey, apiSecret, ...rest } = p;
    return {
      ...rest,
      hasApiKey: !!apiKey,
      apiKeyLast4: apiKey ? apiKey.slice(-4) : null,
      hasApiSecret: !!apiSecret,
      implemented: this.registry.isImplemented(p.code),
    };
  }

  @RequirePermission('manage_providers')
  @Get()
  async list() {
    const rows = await this.prisma.providerSetting.findMany({ orderBy: { id: 'asc' } });
    return rows.map((p) => this.sanitize(p));
  }

  /** Per-provider management page: settings + live usage against its limits. */
  @RequirePermission('manage_providers')
  @Get(':id')
  async detail(@Param('id', ParseIntPipe) id: number) {
    const provider = await this.prisma.providerSetting.findUnique({ where: { id } });
    if (!provider) throw new BadRequestException('Unknown provider');
    const startOfDay = new Date();
    startOfDay.setHours(0, 0, 0, 0);
    const since30 = new Date(Date.now() - 30 * 86400_000);
    const [callsToday, spentTodayAgg, live30, cache30, cost30] = await Promise.all([
      this.prisma.providerUsage.count({ where: { providerId: id, createdAt: { gte: startOfDay }, cacheHit: false } }),
      this.prisma.providerUsage.aggregate({
        where: { providerId: id, createdAt: { gte: startOfDay }, cacheHit: false },
        _sum: { costCents: true },
      }),
      this.prisma.providerUsage.count({ where: { providerId: id, createdAt: { gte: since30 }, cacheHit: false } }),
      this.prisma.providerUsage.count({ where: { providerId: id, createdAt: { gte: since30 }, cacheHit: true } }),
      this.prisma.providerUsage.aggregate({
        where: { providerId: id, createdAt: { gte: since30 }, cacheHit: false },
        _sum: { costCents: true },
      }),
    ]);
    return {
      ...this.sanitize(provider),
      usage: {
        callsToday,
        spentTodayCents: spentTodayAgg._sum.costCents ?? 0,
        last30d: {
          liveCalls: live30,
          cacheHits: cache30,
          costCents: cost30._sum.costCents ?? 0,
          cacheHitRate: live30 + cache30 > 0 ? Math.round((cache30 / (live30 + cache30)) * 100) : 0,
        },
      },
    };
  }

  /** Add a custom provider entry to the catalog (inactive until an adapter exists). */
  @RequirePermission('manage_providers')
  @Post()
  async create(@CurrentUser() user: AuthUser, @Body() dto: CreateProviderDto, @Ip() ip: string) {
    const existing = await this.prisma.providerSetting.findUnique({ where: { code: dto.code } });
    if (existing) throw new ConflictException(`Provider ${dto.code} already exists`);
    const created = await this.prisma.providerSetting.create({
      data: { ...dto, isActive: false },
    });
    await this.audit.log({
      userId: user.id, action: 'PROVIDER_CREATED', ip,
      detail: { providerId: created.id, code: created.code },
    });
    return this.sanitize(created);
  }

  @RequirePermission('manage_providers')
  @Patch(':id')
  async update(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: UpdateProviderDto,
    @Ip() ip: string,
  ) {
    const provider = await this.prisma.providerSetting.findUnique({ where: { id } });
    if (!provider) throw new BadRequestException('Unknown provider');

    if (dto.isActive === true) {
      // 1) An adapter must exist, or every search would fail.
      if (!this.registry.isImplemented(provider.code)) {
        throw new BadRequestException(
          `${provider.displayName} has no adapter implemented yet. Credentials can be saved now; ask your developer to add the ${provider.code} adapter before activating.`,
        );
      }
      // 2) Paid providers need credentials on file. The built-in self-hosted
      //    providers (MOCK, LEADTRACE_ENGINE) are credential-free.
      const CREDENTIAL_FREE = ['MOCK', 'LEADTRACE_ENGINE'];
      if (!CREDENTIAL_FREE.includes(provider.code) && !provider.apiKey && !dto.apiKey) {
        throw new BadRequestException('Save the API credentials before activating this provider.');
      }
      // 3) A provider cannot be activated without a permitted-use attestation (spec §8).
      const attestation = dto.permittedUseAttestation ?? provider.permittedUseAttestation;
      if (!attestation) {
        throw new BadRequestException(
          'Record a permitted-use attestation before activating this provider (sales lead-generation only; no FCRA/DPPA/GLBA-restricted uses).',
        );
      }
    }

    const updated = await this.prisma.$transaction(async (tx) => {
      // Exactly one active provider at a time
      if (dto.isActive === true) {
        await tx.providerSetting.updateMany({ where: { NOT: { id } }, data: { isActive: false } });
      }
      return tx.providerSetting.update({
        where: { id },
        data: {
          isActive: dto.isActive,
          costPerSearchCents: dto.costPerSearchCents,
          dailySpendCapCents: dto.dailySpendCapCents,
          dailyRequestLimit: dto.dailyRequestLimit,
          cacheTtlHours: dto.cacheTtlHours,
          description: dto.description,
          websiteUrl: dto.websiteUrl,
          signupUrl: dto.signupUrl,
          docsUrl: dto.docsUrl,
          howToGet: dto.howToGet,
          baseUrl: dto.baseUrl,
          apiKey: dto.apiKey,
          apiSecret: dto.apiSecret,
          ...(dto.permittedUseAttestation
            ? {
                permittedUseAttestation: dto.permittedUseAttestation,
                attestedById: user.id,
                attestedAt: new Date(),
              }
            : {}),
        },
      });
    });
    await this.audit.log({
      userId: user.id, action: 'PROVIDER_UPDATED', ip,
      detail: {
        providerId: id,
        code: provider.code,
        // note which fields changed, never the values (keys stay out of the log)
        changes: Object.keys(dto),
      },
    });
    return this.sanitize(updated);
  }
}
