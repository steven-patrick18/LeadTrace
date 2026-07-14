import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Ip,
  Param,
  ParseIntPipe,
  Patch,
} from '@nestjs/common';
import { IsBoolean, IsInt, IsOptional, IsString, Min, MinLength } from 'class-validator';
import { AuditService } from '../common/audit.service';
import { AuthUser, CurrentUser, RequirePermission } from '../common/decorators';
import { PrismaService } from '../common/prisma.service';

class UpdateProviderDto {
  @IsOptional() @IsBoolean() isActive?: boolean;
  @IsOptional() @IsInt() @Min(0) costPerSearchCents?: number;
  @IsOptional() @IsInt() @Min(0) dailySpendCapCents?: number;
  @IsOptional() @IsInt() @Min(1) cacheTtlHours?: number;
  /** Permitted-use attestation (spec §8): sales lead-gen only, never FCRA/DPPA/GLBA uses. */
  @IsOptional() @IsString() @MinLength(20) permittedUseAttestation?: string;
}

@Controller('providers')
export class ProvidersController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  @RequirePermission('manage_providers')
  @Get()
  list() {
    return this.prisma.providerSetting.findMany({ orderBy: { id: 'asc' } });
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

    // A provider cannot be activated without a recorded permitted-use attestation (spec §8)
    if (dto.isActive === true) {
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
          cacheTtlHours: dto.cacheTtlHours,
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
      detail: { providerId: id, code: provider.code, changes: Object.keys(dto) },
    });
    return updated;
  }
}
