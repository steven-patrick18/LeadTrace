import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { Lead } from '@prisma/client';
import { AuthUser } from '../common/decorators';
import { PrismaService } from '../common/prisma.service';
import { PermissionsService } from '../permissions/permissions.service';

/**
 * Central per-lead access rules:
 *  - Admin can revoke any person's access to a specific lead (lead_access_blocks).
 *    A block overrides ownership AND view_all_leads — only manage_lead_access
 *    holders (admins) are immune, so a block can never lock the admin out.
 *  - "Participants" (for commenting) = the lead's creator, current assignee,
 *    anyone it was ever routed to/from, and anyone who logged activity on it —
 *    plus manager/admin via view_all_leads.
 */
@Injectable()
export class LeadAccessService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly permissions: PermissionsService,
  ) {}

  async isBlocked(userId: number, leadId: number, roleId: number): Promise<boolean> {
    const immune = (await this.permissions.check(roleId, 'manage_lead_access')).allowed;
    if (immune) return false;
    const block = await this.prisma.leadAccessBlock.findUnique({
      where: { leadId_userId: { leadId, userId } },
    });
    return !!block;
  }

  /** Read access: owner/assignee or view_all_leads, minus blocks. Returns the lead. */
  async assertViewAccess(user: AuthUser, leadId: number): Promise<Lead> {
    const lead = await this.prisma.lead.findUnique({ where: { id: leadId } });
    if (!lead) throw new NotFoundException('Lead not found');
    if (await this.isBlocked(user.id, leadId, user.roleId)) {
      throw new ForbiddenException('Your access to this lead has been revoked by an admin');
    }
    const canViewAll = (await this.permissions.check(user.roleId, 'view_all_leads')).allowed;
    if (!canViewAll && lead.assignedToId !== user.id && lead.createdById !== user.id) {
      throw new ForbiddenException('You can only access your own leads');
    }
    return lead;
  }

  /** Comment rule: manager/admin (view_all) or anyone who worked this lead. */
  async assertParticipant(user: AuthUser, leadId: number): Promise<Lead> {
    const lead = await this.prisma.lead.findUnique({ where: { id: leadId } });
    if (!lead) throw new NotFoundException('Lead not found');
    if (await this.isBlocked(user.id, leadId, user.roleId)) {
      throw new ForbiddenException('Your access to this lead has been revoked by an admin');
    }
    const canViewAll = (await this.permissions.check(user.roleId, 'view_all_leads')).allowed;
    if (canViewAll || lead.createdById === user.id || lead.assignedToId === user.id) return lead;

    const [routed, worked] = await Promise.all([
      this.prisma.routingHistory.count({
        where: { leadId, OR: [{ fromUserId: user.id }, { toUserId: user.id }] },
      }),
      this.prisma.activity.count({ where: { leadId, userId: user.id } }),
    ]);
    if (routed === 0 && worked === 0) {
      throw new ForbiddenException('Only managers, admins, and people who worked this lead can comment');
    }
    return lead;
  }

  /** Filter for list queries: exclude leads this user is blocked on (admins immune). */
  async blockFilter(user: AuthUser): Promise<Record<string, unknown>> {
    const immune = (await this.permissions.check(user.roleId, 'manage_lead_access')).allowed;
    return immune ? {} : { accessBlocks: { none: { userId: user.id } } };
  }
}
