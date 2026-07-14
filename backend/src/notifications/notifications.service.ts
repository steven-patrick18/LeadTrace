import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../common/prisma.service';
import { PermissionsService } from '../permissions/permissions.service';

@Injectable()
export class NotificationsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly permissions: PermissionsService,
  ) {}

  /**
   * Notify everyone concerned with a lead: the assignee, the creator, and all
   * oversight users (whoever holds view_all_leads — manager/admin by default).
   * The actor never gets notified about their own action. Every notification
   * carries the leadId so clicking it lands on that lead's page.
   */
  async notifyLeadWatchers(
    leadId: number,
    actorId: number,
    payload: { type: string; title: string; body?: string },
  ) {
    const lead = await this.prisma.lead.findUnique({
      where: { id: leadId },
      select: { assignedToId: true, createdById: true },
    });
    if (!lead) return;
    const oversight = await this.permissions.usersWithPermission('view_all_leads');
    const recipients = new Set<number>([
      ...(lead.assignedToId ? [lead.assignedToId] : []),
      lead.createdById,
      ...oversight.map((u) => u.id),
    ]);
    recipients.delete(actorId);
    await this.notify([...recipients], { ...payload, leadId });
  }

  async notify(
    userIds: number[],
    payload: { type: string; title: string; body?: string; leadId?: number },
    tx?: Prisma.TransactionClient,
  ) {
    if (!userIds.length) return;
    const client = tx ?? this.prisma;
    await client.notification.createMany({
      data: userIds.map((userId) => ({
        userId,
        type: payload.type,
        title: payload.title,
        body: payload.body ?? null,
        leadId: payload.leadId ?? null,
      })),
    });
  }

  list(userId: number, unreadOnly: boolean) {
    return this.prisma.notification.findMany({
      where: { userId, ...(unreadOnly ? { isRead: false } : {}) },
      orderBy: { createdAt: 'desc' },
      take: 50,
    });
  }

  unreadCount(userId: number) {
    return this.prisma.notification.count({ where: { userId, isRead: false } });
  }

  async markRead(userId: number, id?: number) {
    await this.prisma.notification.updateMany({
      where: { userId, ...(id ? { id } : {}) },
      data: { isRead: true },
    });
    return { ok: true };
  }
}
