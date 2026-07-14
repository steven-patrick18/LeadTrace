import {
  Body,
  ConflictException,
  Controller,
  ForbiddenException,
  Ip,
  NotFoundException,
  Param,
  ParseIntPipe,
  Post,
} from '@nestjs/common';
import { IsIn, IsString, MinLength } from 'class-validator';
import { AuditService } from '../common/audit.service';
import { AuthUser, CurrentUser, RequirePermission } from '../common/decorators';
import { PrismaService } from '../common/prisma.service';
import { EnrichmentService } from '../enrichment/enrichment.service';
import { LeadAccessService } from '../leads/lead-access.service';
import { PermissionsService } from '../permissions/permissions.service';

class LogActivityDto {
  @IsIn(['CALL', 'NOTE'])
  type!: 'CALL' | 'NOTE';

  @IsString()
  @MinLength(1)
  detail!: string;
}

@Controller('leads/:leadId/activities')
export class ActivitiesController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly permissions: PermissionsService,
    private readonly enrichment: EnrichmentService,
    private readonly audit: AuditService,
    private readonly leadAccess: LeadAccessService,
  ) {}

  /** Log a call or note (spec: every touch is an activities row). */
  @RequirePermission('log_activity')
  @Post()
  async log(
    @CurrentUser() user: AuthUser,
    @Param('leadId', ParseIntPipe) leadId: number,
    @Body() dto: LogActivityDto,
    @Ip() ip: string,
  ) {
    const lead = await this.prisma.lead.findUnique({ where: { id: leadId } });
    if (!lead) throw new NotFoundException('Lead not found');
    if (await this.leadAccess.isBlocked(user.id, leadId, user.roleId)) {
      throw new ForbiddenException('Your access to this lead has been revoked by an admin');
    }
    const canViewAll = (await this.permissions.check(user.roleId, 'view_all_leads')).allowed;
    if (!canViewAll && lead.assignedToId !== user.id && lead.createdById !== user.id) {
      throw new ForbiddenException('You can only log activity on your own leads');
    }

    // The DNC gate (enrichment spec §D): a lead marked not-callable — by the
    // enrichment scrub or the live in-house opt-out list — cannot have a CALL
    // logged. The block is never silent: it errors visibly and is audited.
    if (dto.type === 'CALL') {
      const gate = await this.enrichment.isCallable(leadId);
      if (!gate.callable) {
        await this.audit.log({
          userId: user.id,
          action: 'CALL_BLOCKED_DNC',
          ip,
          detail: { leadId, reasons: gate.reasons },
        });
        throw new ConflictException({
          message: 'Calling this lead is blocked by compliance',
          reasons: gate.reasons,
        });
      }
    }

    return this.prisma.activity.create({
      data: { leadId, userId: user.id, type: dto.type, detail: dto.detail },
      include: { user: { select: { id: true, name: true } } },
    });
  }
}
