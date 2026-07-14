import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  Ip,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  Put,
} from '@nestjs/common';
import { LeadTier } from '@prisma/client';
import { IsBoolean, IsEnum, IsInt, IsOptional, IsString, MinLength, ValidateIf } from 'class-validator';
import { AuditService } from '../common/audit.service';
import { AuthUser, CurrentUser, RequirePermission } from '../common/decorators';
import { PrismaService } from '../common/prisma.service';
import { LeadAccessService } from '../leads/lead-access.service';
import { NotificationsService } from '../notifications/notifications.service';

class CreateStatusDto {
  @IsEnum(LeadTier) tier!: LeadTier;
  @IsString() @MinLength(2) label!: string;
  @IsOptional() @IsInt() sortOrder?: number;
}

class UpdateStatusDto {
  @IsOptional() @IsString() @MinLength(2) label?: string;
  @IsOptional() @IsInt() sortOrder?: number;
  @IsOptional() @IsBoolean() isActive?: boolean;
}

class SetWorkStatusDto {
  /** null clears the status */
  @ValidateIf((o) => o.statusId !== null)
  @IsInt()
  statusId!: number | null;
}

/**
 * Per-tier WORK statuses: Agent, Sr Agent and Closer each have their own
 * Admin-defined list of dispositions. Separate from the pipeline status
 * (NEW/PENDING_ROUTING/…), which only the routing engine may change.
 */
@Controller()
export class TierStatusesController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly access: LeadAccessService,
    private readonly notifications: NotificationsService,
  ) {}

  /** Everyone needs the lists to render the status dropdown. */
  @RequirePermission('view_own_leads')
  @Get('tier-statuses')
  async list() {
    const rows = await this.prisma.tierStatus.findMany({
      where: { isActive: true },
      orderBy: [{ tier: 'asc' }, { sortOrder: 'asc' }, { id: 'asc' }],
    });
    return {
      AGENT: rows.filter((r) => r.tier === 'AGENT'),
      SR_AGENT: rows.filter((r) => r.tier === 'SR_AGENT'),
      CLOSER: rows.filter((r) => r.tier === 'CLOSER'),
    };
  }

  /** Admin management view — includes inactive + usage counts. */
  @RequirePermission('manage_custom_fields')
  @Get('tier-statuses/all')
  listAll() {
    return this.prisma.tierStatus.findMany({
      orderBy: [{ tier: 'asc' }, { sortOrder: 'asc' }, { id: 'asc' }],
      include: { _count: { select: { leads: true } } },
    });
  }

  @RequirePermission('manage_custom_fields')
  @Post('tier-statuses')
  async create(@CurrentUser() user: AuthUser, @Body() dto: CreateStatusDto, @Ip() ip: string) {
    const existing = await this.prisma.tierStatus.findUnique({
      where: { tier_label: { tier: dto.tier, label: dto.label.trim() } },
    });
    if (existing) throw new BadRequestException('That status already exists for this tier');
    const max = await this.prisma.tierStatus.aggregate({ where: { tier: dto.tier }, _max: { sortOrder: true } });
    const status = await this.prisma.tierStatus.create({
      data: { tier: dto.tier, label: dto.label.trim(), sortOrder: dto.sortOrder ?? (max._max.sortOrder ?? 0) + 1 },
    });
    await this.audit.log({ userId: user.id, action: 'TIER_STATUS_CREATED', ip, detail: { tier: dto.tier, label: status.label } });
    return status;
  }

  /** Rename / reorder / hide. Renames apply everywhere the status is used. */
  @RequirePermission('manage_custom_fields')
  @Patch('tier-statuses/:id')
  async update(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: UpdateStatusDto,
    @Ip() ip: string,
  ) {
    const before = await this.prisma.tierStatus.findUnique({ where: { id } });
    if (!before) throw new BadRequestException('Status not found');
    const status = await this.prisma.tierStatus.update({
      where: { id },
      data: { label: dto.label?.trim(), sortOrder: dto.sortOrder, isActive: dto.isActive },
    });
    await this.audit.log({
      userId: user.id, action: 'TIER_STATUS_UPDATED', ip,
      detail: { id, tier: before.tier, before: before.label, after: status.label, changes: Object.keys(dto) },
    });
    return status;
  }

  /** Hard delete only when unused — otherwise deactivate to keep history honest. */
  @RequirePermission('manage_custom_fields')
  @Delete('tier-statuses/:id')
  async remove(@CurrentUser() user: AuthUser, @Param('id', ParseIntPipe) id: number, @Ip() ip: string) {
    const status = await this.prisma.tierStatus.findUnique({
      where: { id },
      include: { _count: { select: { leads: true } } },
    });
    if (!status) throw new BadRequestException('Status not found');
    if (status._count.leads > 0) {
      throw new BadRequestException(
        `${status._count.leads} lead(s) currently use "${status.label}" — deactivate it instead, or move those leads first.`,
      );
    }
    await this.prisma.tierStatus.delete({ where: { id } });
    await this.audit.log({ userId: user.id, action: 'TIER_STATUS_DELETED', ip, detail: { tier: status.tier, label: status.label } });
    return { ok: true };
  }

  /**
   * The assigned user sets the lead's work status, restricted to the list of
   * the lead's CURRENT tier. Logged on the timeline.
   */
  @RequirePermission('edit_lead')
  @Put('leads/:leadId/work-status')
  async setWorkStatus(
    @CurrentUser() user: AuthUser,
    @Param('leadId', ParseIntPipe) leadId: number,
    @Body() dto: SetWorkStatusDto,
    @Ip() ip: string,
  ) {
    const lead = await this.access.assertViewAccess(user, leadId);
    const scope = user.permissionScope;
    if (scope === 'OWN' && lead.createdById !== user.id) {
      throw new ForbiddenException('edit_lead scope OWN: you may only edit leads you created');
    }
    if (scope === 'ASSIGNED' && lead.assignedToId !== user.id) {
      throw new ForbiddenException('edit_lead scope ASSIGNED: you may only edit leads assigned to you');
    }

    let label = 'cleared';
    if (dto.statusId !== null) {
      const status = await this.prisma.tierStatus.findUnique({ where: { id: dto.statusId } });
      if (!status || !status.isActive) throw new BadRequestException('Unknown or inactive status');
      if (status.tier !== lead.currentTier) {
        throw new BadRequestException(
          `"${status.label}" belongs to the ${status.tier} list — this lead is at ${lead.currentTier}`,
        );
      }
      label = status.label;
    }

    const updated = await this.prisma.lead.update({
      where: { id: leadId },
      data: { workStatusId: dto.statusId },
      include: { workStatus: true },
    });
    await this.prisma.activity.create({
      data: {
        leadId,
        userId: user.id,
        type: 'STATUS_CHANGE',
        detail: dto.statusId === null ? 'Work status cleared' : `Work status → "${label}"`,
      },
    });
    await this.audit.log({ userId: user.id, action: 'LEAD_WORK_STATUS', ip, detail: { leadId, statusId: dto.statusId, label } });
    if (dto.statusId !== null) {
      await this.notifications.notifyLeadWatchers(leadId, user.id, {
        type: 'LEAD_STATUS',
        title: `🏷 ${user.name} set lead #${leadId} (${lead.firstName} ${lead.lastName}) to "${label}"`,
      });
    }
    return updated;
  }
}
