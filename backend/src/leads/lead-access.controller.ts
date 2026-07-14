import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Ip,
  Param,
  ParseIntPipe,
  Post,
} from '@nestjs/common';
import { IsInt, IsString, MinLength } from 'class-validator';
import { AuditService } from '../common/audit.service';
import { AuthUser, CurrentUser, RequirePermission } from '../common/decorators';
import { PrismaService } from '../common/prisma.service';
import { PermissionsService } from '../permissions/permissions.service';

class BlockDto {
  @IsInt() userId!: number;
  @IsString() @MinLength(2) reason!: string;
}

/**
 * Admin-only per-lead access revocation ("admin has access to remove access
 * of leads to any person"). A block hides the lead from that user everywhere —
 * lists, detail, edits, activities, enrichment, comments — and is audited.
 * Users holding manage_lead_access (admins) cannot be locked out.
 */
@Controller('leads/:leadId/access')
export class LeadAccessController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly permissions: PermissionsService,
  ) {}

  @RequirePermission('manage_lead_access')
  @Get()
  async list(@Param('leadId', ParseIntPipe) leadId: number) {
    const lead = await this.prisma.lead.findUnique({
      where: { id: leadId },
      select: { id: true, createdById: true, assignedToId: true },
    });
    if (!lead) throw new BadRequestException('Lead not found');
    const blocks = await this.prisma.leadAccessBlock.findMany({
      where: { leadId },
      include: {
        user: { select: { id: true, name: true } },
        blockedBy: { select: { id: true, name: true } },
      },
      orderBy: { createdAt: 'desc' },
    });
    const users = await this.prisma.user.findMany({
      where: { isActive: true },
      select: { id: true, name: true, role: { select: { displayName: true, roleCode: true } } },
      orderBy: { name: 'asc' },
    });
    return { lead, blocks, users };
  }

  @RequirePermission('manage_lead_access')
  @Post()
  async block(
    @CurrentUser() user: AuthUser,
    @Param('leadId', ParseIntPipe) leadId: number,
    @Body() dto: BlockDto,
    @Ip() ip: string,
  ) {
    const target = await this.prisma.user.findUnique({ where: { id: dto.userId }, include: { role: true } });
    if (!target) throw new BadRequestException('User not found');
    const immune = (await this.permissions.check(target.roleId, 'manage_lead_access')).allowed;
    if (immune) {
      throw new BadRequestException('Users with manage_lead_access (admins) cannot be blocked');
    }
    const existing = await this.prisma.leadAccessBlock.findUnique({
      where: { leadId_userId: { leadId, userId: dto.userId } },
    });
    if (existing) throw new BadRequestException('That user is already blocked on this lead');

    const row = await this.prisma.leadAccessBlock.create({
      data: { leadId, userId: dto.userId, reason: dto.reason, blockedById: user.id },
    });
    await this.prisma.activity.create({
      data: { leadId, userId: user.id, type: 'NOTE', detail: `Access revoked for ${target.name}: ${dto.reason}` },
    });
    await this.audit.log({
      userId: user.id, action: 'LEAD_ACCESS_REVOKED', ip,
      detail: { leadId, targetUserId: dto.userId, reason: dto.reason },
    });
    return row;
  }

  @RequirePermission('manage_lead_access')
  @Delete(':userId')
  async unblock(
    @CurrentUser() user: AuthUser,
    @Param('leadId', ParseIntPipe) leadId: number,
    @Param('userId', ParseIntPipe) userId: number,
    @Ip() ip: string,
  ) {
    const existing = await this.prisma.leadAccessBlock.findUnique({
      where: { leadId_userId: { leadId, userId } },
    });
    if (!existing) throw new BadRequestException('No block found');
    await this.prisma.leadAccessBlock.delete({ where: { id: existing.id } });
    await this.audit.log({
      userId: user.id, action: 'LEAD_ACCESS_RESTORED', ip,
      detail: { leadId, targetUserId: userId },
    });
    return { ok: true };
  }
}
