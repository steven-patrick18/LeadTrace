import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { LeadTier, Prisma, TransferPoint } from '@prisma/client';
import { AuditService } from '../common/audit.service';
import { AuthUser } from '../common/decorators';
import { PrismaService } from '../common/prisma.service';
import { NotificationsService } from '../notifications/notifications.service';
import { PermissionsService } from '../permissions/permissions.service';

/**
 * The call chain (spec §5). INVARIANT (spec §4.1): leads.assigned_to and
 * leads.current_tier are mutated ONLY inside route()/bulkRoute() below —
 * behind the route_leads permission — plus initial assignment at creation.
 * No other code path may touch them; the invariant test greps for violations.
 */

const TARGET_ROLE_CODES: Record<TransferPoint, string[]> = {
  T1_TO_SS: ['SR_AGENT'],
  T2_TO_CLOSER: ['CLOSER'],
  T3_SEND_BACK: ['AGENT', 'SR_AGENT'],
};

const TARGET_TIER: Record<TransferPoint, Record<string, LeadTier>> = {
  T1_TO_SS: { SR_AGENT: 'SR_AGENT' },
  T2_TO_CLOSER: { CLOSER: 'CLOSER' },
  T3_SEND_BACK: { AGENT: 'AGENT', SR_AGENT: 'SR_AGENT' },
};

@Injectable()
export class RoutingService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly notifications: NotificationsService,
    private readonly permissions: PermissionsService,
  ) {}

  /** Agent/SS pushes a lead up (spec §5 steps 2, 4). */
  async requestTransfer(user: AuthUser, leadId: number, note?: string, ip?: string) {
    const lead = await this.prisma.lead.findUnique({ where: { id: leadId } });
    if (!lead) throw new NotFoundException('Lead not found');
    if (lead.assignedToId !== user.id) {
      throw new ForbiddenException('Only the assigned user can request a transfer');
    }
    if (!['NEW', 'IN_PROGRESS', 'QUALIFIED'].includes(lead.status)) {
      throw new BadRequestException(`Cannot request transfer while lead is ${lead.status}`);
    }
    if (lead.currentTier === 'CLOSER') {
      throw new BadRequestException('Closer tier is final — use Close Won / Close Lost / Send Back');
    }
    const transferPoint: TransferPoint = lead.currentTier === 'AGENT' ? 'T1_TO_SS' : 'T2_TO_CLOSER';

    const result = await this.prisma.$transaction(async (tx) => {
      await tx.lead.update({ where: { id: leadId }, data: { status: 'PENDING_ROUTING' } });
      const queueRow = await tx.routingQueue.create({
        data: { leadId, transferPoint, raisedById: user.id },
      });
      await tx.activity.create({
        data: {
          leadId,
          userId: user.id,
          type: 'TRANSFER_REQUEST',
          detail: `Transfer requested (${transferPoint})${note ? `: ${note}` : ''}`,
        },
      });
      await this.audit.log({
        userId: user.id,
        action: 'TRANSFER_REQUESTED',
        ip,
        detail: { leadId, transferPoint },
        tx,
      });
      return queueRow;
    });

    await this.notifyRouters(leadId, `Lead #${leadId} is waiting in the routing queue (${transferPoint})`);
    return result;
  }

  /** Closer finishes the chain (spec §5 step 6). */
  async closeLead(user: AuthUser, leadId: number, outcome: 'CLOSED_WON' | 'CLOSED_LOST', note?: string, ip?: string) {
    const lead = await this.prisma.lead.findUnique({ where: { id: leadId } });
    if (!lead) throw new NotFoundException('Lead not found');
    const scopeAll = user.permissionScope === 'ALL';
    if (!scopeAll && lead.assignedToId !== user.id) {
      throw new ForbiddenException('Only the assigned user can close this lead');
    }
    if (lead.status === 'CLOSED_WON' || lead.status === 'CLOSED_LOST') {
      throw new BadRequestException('Lead is already closed');
    }
    if (lead.currentTier !== 'CLOSER' && !scopeAll) {
      throw new BadRequestException('Deals close at the Closer tier');
    }

    const result = await this.prisma.$transaction(async (tx) => {
      const updated = await tx.lead.update({ where: { id: leadId }, data: { status: outcome } });
      await tx.activity.create({
        data: {
          leadId,
          userId: user.id,
          type: 'STATUS_CHANGE',
          detail: `${outcome === 'CLOSED_WON' ? 'Deal WON' : 'Deal lost'}${note ? `: ${note}` : ''}`,
        },
      });
      await this.audit.log({ userId: user.id, action: 'LEAD_CLOSED', ip, detail: { leadId, outcome }, tx });
      return updated;
    });
    await this.notifications.notifyLeadWatchers(leadId, user.id, {
      type: 'LEAD_CLOSED',
      title: `${outcome === 'CLOSED_WON' ? '🏆' : '❌'} ${user.name} closed lead #${leadId} — ${outcome === 'CLOSED_WON' ? 'WON' : 'lost'}${note ? `: ${note.slice(0, 80)}` : ''}`,
    });
    return result;
  }

  /** Closer sends the lead back down — via the Admin queue, per confirmed decision. */
  async sendBack(user: AuthUser, leadId: number, reason: string, ip?: string) {
    const lead = await this.prisma.lead.findUnique({ where: { id: leadId } });
    if (!lead) throw new NotFoundException('Lead not found');
    if (user.permissionScope !== 'ALL' && lead.assignedToId !== user.id) {
      throw new ForbiddenException('Only the assigned user can send this lead back');
    }
    if (lead.status === 'CLOSED_WON' || lead.status === 'CLOSED_LOST') {
      throw new BadRequestException('Closed leads cannot be sent back — ask an Admin to reopen');
    }

    const result = await this.prisma.$transaction(async (tx) => {
      await tx.lead.update({ where: { id: leadId }, data: { status: 'PENDING_ROUTING' } });
      const queueRow = await tx.routingQueue.create({
        data: { leadId, transferPoint: 'T3_SEND_BACK', raisedById: user.id },
      });
      await tx.activity.create({
        data: { leadId, userId: user.id, type: 'TRANSFER_REQUEST', detail: `Sent back: ${reason}` },
      });
      await this.audit.log({ userId: user.id, action: 'LEAD_SENT_BACK', ip, detail: { leadId, reason }, tx });
      return queueRow;
    });

    await this.notifyRouters(leadId, `Lead #${leadId} was sent back and needs re-routing (T3)`);
    await this.notifications.notifyLeadWatchers(leadId, user.id, {
      type: 'LEAD_SENT_BACK',
      title: `↩️ ${user.name} sent lead #${leadId} back: ${reason.slice(0, 100)}`,
    });
    return result;
  }

  /** The Admin Routing Queue (spec Phase 3): PENDING rows grouped by transfer point, wait time per row. */
  async queue() {
    const rows = await this.prisma.routingQueue.findMany({
      where: { status: 'PENDING' },
      orderBy: { createdAt: 'asc' },
      include: {
        lead: {
          select: {
            id: true, firstName: true, lastName: true, primaryPhone: true,
            city: true, state: true, currentTier: true, status: true,
          },
        },
        raisedBy: { select: { id: true, name: true, role: { select: { displayName: true } } } },
      },
    });
    const now = Date.now();
    const withWait = rows.map((r) => ({ ...r, waitMinutes: Math.floor((now - r.createdAt.getTime()) / 60000) }));
    return {
      T1_TO_SS: withWait.filter((r) => r.transferPoint === 'T1_TO_SS'),
      T2_TO_CLOSER: withWait.filter((r) => r.transferPoint === 'T2_TO_CLOSER'),
      T3_SEND_BACK: withWait.filter((r) => r.transferPoint === 'T3_SEND_BACK'),
    };
  }

  /** Eligible recipients for a transfer point (for the routing UI dropdown). */
  async eligibleRecipients(transferPoint: TransferPoint) {
    return this.prisma.user.findMany({
      where: { isActive: true, role: { roleCode: { in: TARGET_ROLE_CODES[transferPoint] } } },
      select: {
        id: true, name: true,
        role: { select: { roleCode: true, displayName: true } },
        _count: { select: { assignedLeads: { where: { status: { in: ['NEW', 'IN_PROGRESS', 'PENDING_ROUTING'] } } } } },
      },
      orderBy: { name: 'asc' },
    });
  }

  /** Single routing decision (spec §5 steps 3, 5). */
  async route(user: AuthUser, queueId: number, toUserId: number, ip?: string) {
    return (await this.bulkRoute(user, [queueId], toUserId, ip))[0];
  }

  /**
   * Bulk routing (spec Phase 3: "required, not optional — the Admin touches
   * every lead"): multi-select → one recipient, atomically per row.
   */
  async bulkRoute(user: AuthUser, queueIds: number[], toUserId: number, ip?: string) {
    if (!queueIds.length) throw new BadRequestException('No queue rows selected');
    const target = await this.prisma.user.findUnique({ where: { id: toUserId }, include: { role: true } });
    if (!target || !target.isActive) throw new BadRequestException('Recipient not found or inactive');

    const results = [];
    for (const queueId of queueIds) {
      results.push(await this.routeOne(user, queueId, target, ip));
    }
    await this.notifications.notify(
      [toUserId],
      {
        type: 'LEAD_ROUTED',
        title:
          queueIds.length === 1
            ? `A lead was routed to you`
            : `${queueIds.length} leads were routed to you`,
      },
    );
    return results;
  }

  private async routeOne(
    user: AuthUser,
    queueId: number,
    target: { id: number; name: string; role: { roleCode: string } },
    ip?: string,
  ) {
    return this.prisma.$transaction(async (tx) => {
      const row = await tx.routingQueue.findUnique({ where: { id: queueId }, include: { lead: true } });
      if (!row) throw new NotFoundException(`Queue row ${queueId} not found`);
      if (row.status !== 'PENDING') throw new BadRequestException(`Queue row ${queueId} was already routed`);

      const targetTier = TARGET_TIER[row.transferPoint][target.role.roleCode];
      if (!targetTier) {
        throw new BadRequestException(
          `${row.transferPoint} must route to a ${TARGET_ROLE_CODES[row.transferPoint].join(' or ')} — ${target.name} is ${target.role.roleCode}`,
        );
      }

      const fromUserId = row.lead.assignedToId;

      // THE single sanctioned mutation of assigned_to / current_tier (spec §4.1).
      // workStatus resets — the new tier has its own status list.
      const lead = await tx.lead.update({
        where: { id: row.leadId },
        data: { assignedToId: target.id, currentTier: targetTier, status: 'IN_PROGRESS', workStatusId: null },
      });

      await tx.routingQueue.update({
        where: { id: queueId },
        data: { status: 'ROUTED', routedById: user.id, routedToId: target.id, routedAt: new Date() },
      });
      // Append-only history — the conversion funnel reads from this (spec §5)
      await tx.routingHistory.create({
        data: {
          leadId: row.leadId,
          transferPoint: row.transferPoint,
          fromUserId,
          toUserId: target.id,
          routedById: user.id,
        },
      });
      await tx.activity.create({
        data: {
          leadId: row.leadId,
          userId: user.id,
          type: 'STATUS_CHANGE',
          detail: `Routed (${row.transferPoint}) to ${target.name}`,
        },
      });
      await this.audit.log({
        userId: user.id,
        action: 'LEAD_ROUTED',
        ip,
        detail: { leadId: row.leadId, queueId, transferPoint: row.transferPoint, toUserId: target.id },
        tx,
      });
      return lead;
    });
  }

  /** Spec §4 invariant 4: closed leads re-enter the flow only via Admin reopen, logged. */
  async reopen(user: AuthUser, leadId: number, reason: string, ip?: string) {
    const lead = await this.prisma.lead.findUnique({ where: { id: leadId } });
    if (!lead) throw new NotFoundException('Lead not found');
    if (lead.status !== 'CLOSED_WON' && lead.status !== 'CLOSED_LOST') {
      throw new BadRequestException('Only closed leads can be reopened');
    }
    const result = await this.prisma.$transaction(async (tx) => {
      await tx.lead.update({ where: { id: leadId }, data: { status: 'PENDING_ROUTING' } });
      const queueRow = await tx.routingQueue.create({
        data: { leadId, transferPoint: 'T3_SEND_BACK', raisedById: user.id },
      });
      await tx.activity.create({
        data: { leadId, userId: user.id, type: 'STATUS_CHANGE', detail: `Reopened by admin: ${reason}` },
      });
      await this.audit.log({ userId: user.id, action: 'LEAD_REOPENED', ip, detail: { leadId, reason }, tx });
      return queueRow;
    });
    return result;
  }

  private async notifyRouters(leadId: number, title: string) {
    const routers = await this.permissions.usersWithPermission('route_leads');
    await this.notifications.notify(
      routers.map((r) => r.id),
      { type: 'QUEUE_PENDING', title, leadId },
    );
  }
}
