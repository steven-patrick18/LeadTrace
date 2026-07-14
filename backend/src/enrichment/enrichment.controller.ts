import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Ip,
  Param,
  ParseIntPipe,
  Patch,
  Post,
} from '@nestjs/common';
import { IsInt, IsString, Min, MinLength } from 'class-validator';
import { AuditService } from '../common/audit.service';
import { AuthUser, CurrentUser, RequirePermission } from '../common/decorators';
import { toE164 } from '../common/phone.util';
import { PrismaService } from '../common/prisma.service';
import { EnrichmentService } from './enrichment.service';

class WeightDto {
  @IsString() key!: string;
  @IsInt() @Min(0) weight!: number;
}

class DncAddDto {
  @IsString() @MinLength(7) phone!: string;
  @IsString() @MinLength(2) reason!: string;
}

@Controller()
export class EnrichmentController {
  constructor(
    private readonly enrichment: EnrichmentService,
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  @RequirePermission('enrich_lead')
  @Post('leads/:id/enrich')
  enrich(@CurrentUser() user: AuthUser, @Param('id', ParseIntPipe) id: number, @Ip() ip: string) {
    return this.enrichment.enrich(user, id, ip);
  }

  @RequirePermission('view_enrichment')
  @Get('leads/:id/enrichment')
  get(@CurrentUser() user: AuthUser, @Param('id', ParseIntPipe) id: number) {
    return this.enrichment.get(user, id);
  }

  // ── Score weights (Admin) ──────────────────────────────────

  @RequirePermission('edit_score_weights')
  @Get('score-weights')
  weights() {
    return this.prisma.scoreWeight.findMany({ orderBy: { key: 'asc' } });
  }

  @RequirePermission('edit_score_weights')
  @Patch('score-weights')
  async updateWeight(@CurrentUser() user: AuthUser, @Body() dto: WeightDto, @Ip() ip: string) {
    const existing = await this.prisma.scoreWeight.findUnique({ where: { key: dto.key } });
    if (!existing) throw new BadRequestException(`Unknown weight key: ${dto.key}`);
    const updated = await this.prisma.scoreWeight.update({
      where: { key: dto.key },
      data: { weight: dto.weight, updatedBy: user.id },
    });
    await this.audit.log({
      userId: user.id,
      action: 'SCORE_WEIGHT_CHANGED',
      ip,
      detail: { key: dto.key, before: existing.weight, after: dto.weight },
    });
    return updated;
  }

  // ── In-house DNC / opt-out list (authoritative) ────────────

  @RequirePermission('manage_dnc_optout')
  @Get('dnc')
  dncList() {
    return this.prisma.dncOptout.findMany({
      orderBy: { createdAt: 'desc' },
      include: { addedBy: { select: { id: true, name: true } } },
    });
  }

  @RequirePermission('manage_dnc_optout')
  @Post('dnc')
  async dncAdd(@CurrentUser() user: AuthUser, @Body() dto: DncAddDto, @Ip() ip: string) {
    const phone = toE164(dto.phone);
    const existing = await this.prisma.dncOptout.findUnique({ where: { phone } });
    if (existing) throw new BadRequestException('Phone is already on the opt-out list');
    const row = await this.prisma.dncOptout.create({
      data: { phone, reason: dto.reason, addedById: user.id },
    });
    await this.audit.log({ userId: user.id, action: 'DNC_OPTOUT_ADDED', ip, detail: { phone, reason: dto.reason } });
    return row;
  }

  @RequirePermission('manage_dnc_optout')
  @Delete('dnc/:id')
  async dncRemove(@CurrentUser() user: AuthUser, @Param('id', ParseIntPipe) id: number, @Ip() ip: string) {
    const row = await this.prisma.dncOptout.findUnique({ where: { id } });
    if (!row) throw new BadRequestException('Entry not found');
    await this.prisma.dncOptout.delete({ where: { id } });
    await this.audit.log({
      userId: user.id,
      action: 'DNC_OPTOUT_REMOVED',
      ip,
      detail: { phone: row.phone, originalReason: row.reason },
    });
    return { ok: true };
  }
}
